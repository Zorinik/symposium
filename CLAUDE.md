# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Symposium is a Node.js framework (ES modules, Node ≥18) for building LLM-powered agents. Published as the `symposium` npm package; consumed as a library, not a runnable app. No build or lint tooling. Test suite uses the built-in `node:test` runner — run with `npm test` (script: `node --test "test/**/*.test.js"`). Tests live under `test/` and mock provider SDKs to validate the model layer's streaming behavior without network access.

## Architecture

The framework is organized around a small set of cooperating classes at the repo root. Understanding the data flow between them is the fastest way to be productive.

### Bootstrapping (`Symposium.js`)

`Symposium` is a static registry, not an instance. `Symposium.init(storage?)` dynamically imports every file in `Models/` and calls `loadModel()` on each. Each model class returns a `Map` of model definitions (one provider class can register many model labels — see `Models/OpenAIModel.js` registering `gpt-4o`, `gpt-5`, `gpt-5.x`, etc.). Definitions are keyed by label and stored with `{...modelDef, type, class}` where `class` is the provider instance used for actual API calls.

Storage is optional; when present it must implement `init()`, `get(key)`, `set(key, value)`. Threads serialize themselves under `thread-<agent_name>-<thread_id>`.

`Symposium.prompt(system, prompt, options)` is a shortcut: it instantiates a bare `Agent`, marks it as `utility`, and returns the response directly (bypassing the EventEmitter flow).

### Agents (`Agent.js`)

The execution core. Two `type` values change the contract:

- `chat` — `message()` / `trigger()` return a `BufferedEventEmitter`; the caller consumes streaming events. Errors are emitted, not thrown.
- `utility` — same methods return a Promise that resolves to the final value. `utility.type` may be `text`, `function`, or `json`. For `json` with a structured-output-capable model AND ≤100 parameters, the agent uses OpenAI's `response_format: json_schema`; otherwise it falls back to a forced function call. See `convertFunctionToResponseFormat()` for the OpenAI-specific schema constraints (all properties forced to required, `additionalProperties: false`).

The `execute()` loop is recursive with a `max_retries` (default 5) safety net: generate completion → `afterExecute` hook → emit reasoning → `handleCompletion` → if the assistant called functions, run them and recurse with `{type: 'continue'}`; otherwise resolve. Subclasses customize via `doInitThread`, `getDefaultState`, `beforeExecute`, `afterExecute`, `afterHandle`.

Tool authorization is two-phase: `Tool.authorize()` runs before the call; if it returns false, an `tools_auth` event is emitted and execution suspends. The caller invokes `agent.confirmFunctions(...)` to resume (optionally calling `authorizeAlways` to remember the decision).

### Models (`Models/*.js`, base in `Model.js`)

Every provider extends `Model` and implements:
- `getModels()` — returns `Map<label, definition>` where definition flags capabilities: `tools`, `structured_output`, `audio`, `image_generation`, `tokens` (context window), `tiktoken` (encoding name).
- `generate(model, thread, functions, options)` — **async generator** (Phase 1 of v3 refactor). Yields streaming deltas during generation and `return`s the final assembled `Message[]`. Delta union: `{type: 'text_delta', content}`, `{type: 'reasoning_delta', content}`, `{type: 'tool_call', content: {id?, name, arguments}}` (emitted complete), `{type: 'image', content, meta}`. The agent currently drains the generator in `Agent.generateCompletion()` and uses only the return value; Phase 2 will forward deltas to consumers. Tool-call deltas from chat-completions-style APIs (OpenAI legacy, Groq) are accumulated per `index` and yielded once at end-of-stream.
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

### Event flow (`BufferedEventEmitter.js`)

`Agent.execute()` emits events synchronously, but a `chat` agent returns the emitter to the caller who attaches listeners *after* events have already fired. `BufferedEventEmitter` buffers any emit with no listeners and flushes the buffer when `on()` is later called for that event. Don't replace it with a stock `EventEmitter` — the streaming UX depends on this behavior.

Standard events: `start`, `output` (text/image chunks), `reasoning`, `tool`, `tool_response`, `tools_auth`, `error`, `end`.

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
