# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Symposium is a Node.js framework (ES modules, Node ≥18) for building LLM-powered agents. Published as the `symposium` npm package; consumed as a library, not a runnable app. No build or lint tooling. Test suite uses the built-in `node:test` runner — run with `npm test` (script: `node --test "test/**/*.test.js"`). Tests live under `test/` and mock provider SDKs to validate the model layer's streaming behavior without network access.

The codebase was refactored to its current shape in the 3.0 release (async-generator API, streaming input channel, real model streaming, hybrid retry, `response_schema`). See `MIGRATION.md` for 2.x → 3.0 side-by-side patterns and `README.md` for consumer-facing docs.

## Architecture

The framework is organized around a small set of cooperating classes at the repo root. Understanding the data flow between them is the fastest way to be productive.

### Bootstrapping (`Symposium.js`)

`Symposium` is a static registry, not an instance. `Symposium.init(storage?)` dynamically imports every file in `Models/` and calls `loadModel()` on each. Each model class returns a `Map` of model definitions (one provider class can register many model labels — see `Models/OpenAIModel.js` registering `gpt-4o`, `gpt-5`, `gpt-5.x`, etc.). Definitions are keyed by label and stored with `{...modelDef, type, class}` where `class` is the provider instance used for actual API calls.

Storage is optional; when present it must implement `init()`, `get(key)`, `set(key, value)`. Threads serialize themselves under `thread-<agent_name>-<thread_id>`.

`Symposium.prompt(system, prompt, options)` is a shortcut: it instantiates a bare `Agent`, marks it as `utility`, drains the agent's event generator, and returns the value carried by the final `{type:'result', value}` event.

### Agents (`Agent.js`)

The execution core. After Phase 6, `agent.message()` is a non-generator dispatcher: for `chat` agents it returns an async generator (`_messageAsStream`); for `utility` agents it returns a `Promise<value>` (`_messageAsValue` drains the generator internally). `trigger()` and `execute()` remain async generators. Callers do `for await (const ev of agent.message(...))` for chat, and `const value = await agent.message(...)` for utility.

`message(content, thread)` accepts three input shapes (Phase 3): a plain `string`, a `ContentBlock[]`, or an `AsyncIterable<string | ContentBlock | ContentBlock[] | ControlMessage>`. The first two behave as they always have — one user turn, one model loop, done. An async iterable enables streaming input: the agent drains the iterable into the initial user message (stopping on a `{type:'submit'}` control message, on iterable close, or once at least one content piece has arrived and the next read would block), kicks off the loop, then keeps reading concurrently. New content items pushed during a turn are queued and inserted as a user message at the next inter-turn boundary. A `{type:'cancel'}` control message terminates the loop gracefully after the in-flight turn. `{type:'auth', id, decision}` control messages carry tool-authorization responses — see the tool-authorization paragraph below. Use `createInputChannel()` (exported from `index.js`) for a simple promise-queue-backed `AsyncIterable` with `send(item)` / `close()` methods; under the hood it's implemented in `InputChannel.js`. For streaming input, the chat agent does NOT terminate after a no-tool-call turn — it waits for the next message; the run ends only when the iterable closes (or cancel is received).

- `chat` — yields the full event set (`start`, `chunk`, `output`, `reasoning`, `tool`, `tool_response`, `tools_auth`, `retry`, `end`). If `response_schema` is set, the final assistant message is parsed against it and a `{type:'result', value}` event is yielded before `end`; the run terminates after the schema-conforming answer (no further turns).
- `utility` — `await agent.message(...)` resolves to the parsed value. With no `response_schema`, the value is the raw assistant text. With `response_schema` set, the value is the parsed JSON object: structured-output-capable models with ≤100 properties use `response_format: json_schema`; otherwise the agent falls back to a forced function call (synthetic name `'response'`) and parses its arguments. See `convertFunctionToResponseFormat()` for the OpenAI-specific schema constraints (all properties forced to required, `additionalProperties: false`). The legacy `agent.utility = {type, function, parameters}` shape was removed in Phase 6 — use `response_schema` (a raw JSON schema) instead. `response_schema` is independent of `type` and works on chat agents too.

The `execute()` loop is a `while (true)` inside an async generator with a `max_retries` (default 5) safety net wrapped around the entire turn: generate completion (forwarding `text_delta` deltas as `{type:'chunk'}` events and flipping a per-turn `output_yielded` flag) → `afterExecute` hook → yield reasoning → `handleCompletion` → if the assistant called functions, run them via `callFunctions` and loop; otherwise return. On error, the loop retries up to `max_retries` times per turn (hybrid strategy, Phase 5): silent if no chunk has been yielded yet, otherwise it emits `{type:'retry', attempt, reason}` so the consumer knows. A 1-second backoff is preserved for transport-level 5xx errors. Tool-execution errors are NOT retried — they're caught in `callFunction()` and surfaced as `{type:'tool_response', success:false, error}`. Errors throw out of the generator naturally — there is no `error` event. Subclasses customize via `doInitThread`, `getDefaultState`, `beforeExecute(thread)`, `afterExecute(thread, completion)`, `afterHandle(thread, completion, value?)` (note: hooks no longer receive an emitter; the parameter was dropped in v3 Phase 2).

Tool authorization is two-phase (Phase 4): `Tool.authorize()` runs before the call; if it returns false for any function in the pending batch, a `{type:'tools_auth', id, functions}` event is yielded and the generator suspends. The consumer resumes by sending `{type:'auth', id, decision}` through the streaming input channel, where `decision ∈ {'approve', 'approve_always', 'reject'}` (`approve_always` calls `tool.authorizeAlways()` on each function in the batch to persist the decision). The background reader routes the auth message into `inputState.pendingAuthResponses` and signals the notifier, so `_awaitAuthDecision(thread, id)` (the notifier-loop helper) wakes and resumes the run. Two implicit-reject rules close the loophole: if the input iterable closes (`readerFinished`) before a decision arrives, the decision is treated as `'reject'` and the agent loop is cancelled; and if `agent.message()` was called with a plain `string` / `ContentBlock[]` (no channel), any auth request auto-rejects since there's no way to deliver a decision. The legacy `agent.confirmFunctions()` callback API was removed in Phase 4 — consumers must use a channel.

Within a single LLM turn, tools are executed **sequentially** (in `functions_to_call` order), so event ordering is deterministic. The previous parallel `Promise.all` invocation was dropped in Phase 2 to keep the event stream coherent.

### Models (`Models/*.js`, base in `Model.js`)

Every provider extends `Model` and implements:
- `getModels()` — returns `Map<label, definition>` where definition flags capabilities: `tools`, `structured_output`, `audio`, `image_generation`, `tokens` (context window), `tiktoken` (encoding name).
- `generate(model, thread, functions, options)` — **async generator** (Phase 1 of v3 refactor). Yields streaming deltas during generation and `return`s the final assembled `Message[]`. Delta union: `{type: 'text_delta', content}`, `{type: 'reasoning_delta', content}`, `{type: 'tool_call', content: {id?, name, arguments}}` (emitted complete), `{type: 'image', content, meta}`. `Agent.generateCompletion()` (Phase 2) is itself an async generator: it forwards `text_delta` to consumers as `{type:'chunk', content}` events and returns the assembled `Message[]`. Other delta types are not forwarded yet and only contribute to the final assembly. Tool-call deltas from chat-completions-style APIs (OpenAI legacy, Groq) are accumulated per `index` and yielded once at end-of-stream.
- Optionally `countTokens(thread)` (used by `Summarizer`).

A model definition's `tools: true` means the provider supports native function calling. When false, `Agent.parseFunctions()` falls back to parsing `\`\`\`\nCALL <name>\n<json>\n\`\`\`` blocks out of plain text — the prompt for this is built by `Model.promptFromFunctions()` (in Italian; do not translate without verifying the existing parser still matches).

`Model.type` is `'llm'` by default but can also be `'stt'` (transcription, see `OpenAITranscribe.js`) or `'embedding'` (see `OpenAIEmbedding.js`). `Symposium.transcribe()` and `Symposium.embed()` route to whichever model is named in `process.env.TRANSCRIPTION_MODEL` / `EMBEDDING_MODEL`.

### Threads & Messages (`Thread.js`, `Message.js`)

A `Thread` owns the message history and a free-form `state` object (which always includes `model`). Messages are `{role, content[], name?, tags[]}`; `content` is always an array of typed parts (`text`, `image`, `audio`, `function`, `function_response`, `reasoning`). Use `addMessage()` for normal flow and `addPlannedMessage()` + `flushPlannedMessages()` to stage messages that should only land after a tool batch completes.

`thread.unique` (`<agent_name>-<id>`) is the storage key — never reuse the same thread id across agents with different names without realizing they share namespace.

### Context system (`Context.js`, `Contexts/*.js`, `ContextHandler.js`, `Summarizer.js`, `GetContextTool.js`)

Two distinct concepts share the word "context":

1. **`Context` / `Contexts/*`** — static reference material attached to an agent via `agent.addContext(text_or_context, {type: 'always' | 'on_request'})`. `always` contexts are inlined into the system message at thread init; `on_request` contexts are advertised by title/description and fetched lazily through the auto-injected `GetContextTool`. Mixing both is supported.
2. **`ContextHandler`** — pre-execute hook (set as `options.memory_handler` on the agent) that can transform the thread before each LLM call. `Summarizer` extends this: when token count crosses `threshold * model.tokens`, it summarizes earlier messages down to `summary_length * model.tokens`, preserving the system prompt.

### Event flow (async generator)

`Agent.message()` / `trigger()` / `execute()` are async generators. The caller iterates with `for await (const ev of agent.message(...))`. There is no emitter, no listener-attach race, and no `BufferedEventEmitter` (removed in Phase 2). Each event is a discriminated union:

| Event | Payload | Notes |
|---|---|---|
| `{type:'start', thread}` | thread object | First yield |
| `{type:'chunk', content}` | text delta string | Streamed during model generation |
| `{type:'output', content}` | text/image content block | Yielded once the model finishes a message |
| `{type:'reasoning', content}` | reasoning text | Yielded after assembly, per reasoning block |
| `{type:'tool', id, name, arguments}` | flattened function call | Before invoking a tool |
| `{type:'tool_response', name, success, response?, error?}` | tool result | After tool returns or throws |
| `{type:'tools_auth', id, functions}` | uuid + pending function calls | When `tool.authorize()` returns false; resume by sending `{type:'auth', id, decision}` on the input channel |
| `{type:'retry', attempt, reason}` | 1-indexed retry number + error message | Yielded only when an error occurs AFTER at least one `chunk` has been streamed for the current turn (hybrid retry, Phase 5). Errors before any output are retried silently. |
| `{type:'result', value}` | parsed value | Utility agents only |
| `{type:'end', thread}` | thread object | Always yielded, even on throw (yielded from a `finally`) |

Errors throw out of the generator. There is no `error` event anymore.

## Conventions specific to this repo

- ES modules everywhere (`"type": "module"`); always use `import`/`export` and include the `.js` extension in relative imports.
- Tabs for indentation; trailing commas in multi-line literals.
- The fallback function-call prompt in `Model.promptFromFunctions()` and the realtime session preamble in `Agent.createRealtimeSession()` are written in Italian by design — keep them that way unless explicitly changing the language contract.
- When adding a new provider, drop the file in `Models/` and `Symposium.init()` will pick it up automatically — there is no registry to update. The class must `extends Model` and `export default`.
- When adding new public exports, update `index.js` (the package entry point).
- Bump `package.json` version on releases (see recent commits — `add support for gpt-5.4 model in OpenAIModel.js`, `bump version to 2.4.0`).

## Required environment

Set in a `.env` file at the consumer's project root (the framework reads `process.env` directly, no dotenv loader is bundled):

- `OPENAI_API_KEY` — also required for realtime voice sessions
- `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY` — per-provider
- `TRANSCRIPTION_MODEL`, `EMBEDDING_MODEL` — model labels routed to STT/embedding providers
