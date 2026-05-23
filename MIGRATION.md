# Migrating from Symposium 2.x to 3.0

Symposium 3.0 is a major release with breaking API changes. The core idea: replace the `EventEmitter`-based agent API with **async generators**, and let consumers push messages into a running agent via a **streaming input channel**.

This guide walks through the most common patterns side by side.

## TL;DR

| 2.x | 3.0 |
|---|---|
| `agent.message()` returns an `EventEmitter` | `agent.message()` returns an `AsyncGenerator` for chat agents, `Promise<value>` for utility agents |
| `emitter.on('output', ...)` | `for await (const ev of agent.message(...))` |
| `emitter.on('error', ...)` | `try { for await ... } catch (err) { ... }` |
| `agent.confirmFunctions(thread, fns, completion, decision)` | `input.send({ type: 'auth', id, decision })` on the input channel |
| `agent.utility = { type, function, parameters }` | `agent.response_schema = <json-schema>` (works on chat agents too) |
| Fake "chunks" synthesized after the model finished | Real `chunk` events streamed as tokens arrive |
| No way to push messages mid-run | Pass an `AsyncIterable` (see `createInputChannel()`) |

## 1. Simple chat

**Before (2.x):**

```javascript
const emitter = await agent.message('Hello');

emitter.on('output', msg => {
	if (msg.type === 'text')
		process.stdout.write(msg.content);
});
emitter.on('error', err => console.error(err));
emitter.on('end', () => console.log('done'));
```

**After (3.0):**

```javascript
try {
	for await (const ev of agent.message('Hello')) {
		if (ev.type === 'chunk')
			process.stdout.write(ev.content);
	}
	console.log('done');
} catch (err) {
	console.error(err);
}
```

Key changes:

-	No `await` needed before iteration — `agent.message()` returns the generator synchronously.
-	**Use `chunk` for incremental streaming.** It carries text deltas as they arrive from the provider (true streaming, finally). The old `output` event still exists, but it now carries the fully assembled content block for the assistant message — you'd use it if you only care about the final result.
-	Errors throw out of the generator. The `error` event is gone — wrap the loop in `try/catch`.
-	The `end` event still exists but mainly for side-channel cleanup; the loop simply finishes.

## 2. Tools

**Before (2.x):**

```javascript
const emitter = await agent.message('What is the weather in Paris?');

emitter.on('tool', tool => {
	console.log(`> calling ${tool.name}`);
});
emitter.on('tool_response', resp => {
	if (resp.success)
		console.log(`> ${resp.name} OK`);
	else
		console.log(`> ${resp.name} FAILED: ${resp.error}`);
});
```

**After (3.0):**

```javascript
for await (const ev of agent.message('What is the weather in Paris?')) {
	switch (ev.type) {
		case 'tool':
			console.log(`> calling ${ev.name}`);
			break;
		case 'tool_response':
			if (ev.success)
				console.log(`> ${ev.name} OK`);
			else
				console.log(`> ${ev.name} FAILED: ${ev.error}`);
			break;
	}
}
```

Same event shapes, different delivery mechanism. Note that tools within a single LLM turn now execute **sequentially** in the order the model requested them, so `tool` / `tool_response` events arrive in deterministic order.

## 3. Tool authorization

This is the biggest behavioral change. The old `confirmFunctions` callback is gone.

**Before (2.x):**

```javascript
const emitter = await agent.message('Run that risky thing');

emitter.on('tools_auth', async ({ thread, functions, completion }) => {
	const decision = await askUser(functions); // 'approve' | 'approve_always' | 'reject'
	await agent.confirmFunctions(thread, functions, completion, decision);
});
```

**After (3.0):**

```javascript
import { createInputChannel } from 'symposium';

const input = createInputChannel();
input.send('Run that risky thing');

for await (const ev of agent.message(input)) {
	if (ev.type === 'tools_auth') {
		const decision = await askUser(ev.tools); // 'approve' | 'approve_always' | 'reject'
		input.send({ type: 'auth', id: ev.id, decision });
	}
}
```

Key changes:

-	You now need an **input channel** to deliver the auth decision (there's no callback to call).
-	The `tools_auth` event carries an `id` (UUID) — echo it back in the `auth` control message so the agent knows which pending batch you're answering.
-	If you call `agent.message()` with a plain string and a tool requires auth, the agent **auto-rejects** the call (no channel = no way to respond).
-	If the channel closes while a `tools_auth` is pending, it's treated as a reject and the run cancels.

## 4. Structured output

The old `utility = { type, function, parameters }` shape was removed. Use `response_schema` (a raw JSON schema) instead. `response_schema` is independent of the agent type — it works on chat agents too.

**Before (2.x):**

```javascript
class ExtractorAgent extends Agent {
	type = 'utility';
	utility = {
		type: 'json',
		function: {
			name: 'extract',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					email: { type: 'string' },
				},
				required: ['name', 'email'],
			},
		},
	};
}

const result = await extractor.message('My name is John, john@example.com');
// result was already the parsed value — that part hasn't changed.
```

**After (3.0):**

```javascript
class ExtractorAgent extends Agent {
	type = 'utility';
	response_schema = {
		type: 'object',
		properties: {
			name: { type: 'string' },
			email: { type: 'string' },
		},
		required: ['name', 'email'],
	};
}

const result = await extractor.message('My name is John, john@example.com');
// { name: 'John', email: 'john@example.com' }
```

For a **chat agent with a structured final answer**, the parsed value arrives as a `result` event right before `end`:

```javascript
agent.response_schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };

for await (const ev of agent.message('Look up the weather and answer in JSON')) {
	if (ev.type === 'result')
		console.log(ev.value); // { city: '...' }
}
```

## 5. Streaming user input

New in 3.0 — there was no 2.x equivalent.

```javascript
import { createInputChannel } from 'symposium';

const input = createInputChannel();
input.send('Plan a trip to Rome');

const events = agent.message(input);

// Concurrently, from anywhere else:
setTimeout(() => input.send('Actually, make it Florence instead'), 2000);

for await (const ev of events) {
	if (ev.type === 'chunk')
		process.stdout.write(ev.content);
}

// End the run when you're done sending:
input.close();
```

Behavior:

-	The agent starts the first model turn once content has arrived (or once a `{type:'submit'}` control message lands).
-	New items pushed mid-turn are queued and inserted as a `user` message at the next inter-turn boundary (after the current tool batch finishes — there is no mid-turn cancellation of the model call).
-	The run continues across multiple turns until you `input.close()` or send `{type:'cancel'}`.

## 6. Retries

Agents always retried on transport errors. In 3.0 the retry is now visible to the consumer **when it matters**:

-	If no `chunk` has been streamed yet for the current turn → silent retry (most cases: connection error before any tokens).
-	If at least one `chunk` has streamed → yield `{type:'retry', attempt, reason}` so the consumer can clear partial output or show a spinner.

```javascript
for await (const ev of agent.message('Hello')) {
	if (ev.type === 'retry')
		console.warn(`retrying (${ev.attempt}): ${ev.reason}`);
}
```

## 7. Lifecycle hooks

If you've subclassed `Agent` and overridden `beforeExecute` / `afterExecute` / `afterHandle`, the `emitter` parameter was removed:

```javascript
// Before:
async afterHandle(thread, completion, emitter) { ... }

// After:
async afterHandle(thread, completion, value) { ... }
//   `value` is the parsed result when `response_schema` is set; undefined otherwise.
```

If your hook used to emit events on the emitter, that's no longer possible directly. Hooks now run inside the generator pipeline — if you need to surface information, return it from the hook or stash it on the thread state and let the consumer read it from the events.

## 8. `BufferedEventEmitter`

Deleted. The class only existed to paper over the listener-attach race created by `agent.message()` returning an emitter. With async generators, the issue doesn't exist.

## 9. Things that did NOT change

-	Agent / Thread / Toolkit / Message / Context class shapes.
-	Model registration (drop a file in `Models/`, `Symposium.init()` picks it up).
-	Storage adapter interface (`init` / `get` / `set`).
-	`Symposium.prompt()` — still a one-shot value-returning helper.
-	`Symposium.transcribe()` / `Symposium.embed()`.
-	Real-time session API (`agent.createRealtimeSession()`).
-	Italian-language fallback prompt in `Model.promptFromTools()` and the realtime session preamble.

## 10. Notes & gotchas

-	**Backpressure.** Async generators are pull-driven: a slow consumer pauses the model upstream. This is generally an improvement over fire-and-forget emitter events, but it's a behavioral change to be aware of.
-	**Multi-consumer.** Async generators are single-consumer. If you need to fan out an agent run to two listeners, tee it manually.
-	**`message()` is not `async`.** It returns the generator synchronously for chat agents (no `await`). Utility agents return a Promise — same as before in spirit, but it now resolves to the value directly without a separate event loop.

---

# Additional breaking changes in 3.0

3.0 ships a vocabulary cleanup to align with industry terminology (OpenAI/Anthropic/LangChain all use **tool** and **toolkit**, not **function**). It also adds first-class **MCP** support — see the `addMCPServer()` section in `README.md` / `CLAUDE.md`. The renames below are purely cosmetic but pervasive; runtime semantics are unchanged.

## A. `Tool` class → `Toolkit`

The base class for "a thing that publishes one or more LLM-callable tools" is now `Toolkit`. The word **tool** is reserved for the individual callable unit (which is what the LLM actually sees).

| 2.x                                                 | 3.x                                                    |
|-----------------------------------------------------|--------------------------------------------------------|
| `Tool.js` / `GetContextTool.js`                     | `Toolkit.js` / `GetContextToolkit.js`                  |
| `import { Tool } from 'symposium'`                  | `import { Toolkit } from 'symposium'`                  |
| `class Weather extends Tool`                        | `class Weather extends Toolkit`                        |
| `agent.addTool(t)`                                  | `agent.addToolkit(t)`                                  |
| `agent.tools` — `Map<toolkitName, Toolkit>`         | `agent.toolkits` — `Map<toolkitName, Toolkit>`         |
| *(internal: `agent.functions` / `agent.toolIndex`)* | `agent.tools` — `Map<toolName, {toolkit, definition}>` |

The two maps swapped roles on purpose: `agent.tools` is now the flat lookup of LLM-callables (matching how every provider's API talks about "tools"), and `agent.toolkits` is the registry of `Toolkit` instances. Lookup entries are now `{toolkit, definition}` (was `{tool, function}`).

## B. `function` → `tool` everywhere

The framework no longer uses the word **function** for LLM-callable units. Method names, parameter names, message content types, option keys, and event payload keys all changed.

### Method renames

| 2.x                                              | 3.x                                        |
|--------------------------------------------------|--------------------------------------------|
| `Toolkit.getFunctions()`                         | `Toolkit.getTools()`                       |
| `Toolkit.callFunction(thread, name, payload)`    | `Toolkit.callTool(thread, name, payload)`  |
| `Agent.getFunctions()`                           | `Agent.getTools()`                         |
| `Agent.callFunction()` / `Agent.callFunctions()` | `Agent.callTool()` / `Agent.callTools()`   |
| `Agent.parseFunctions()`                         | `Agent.parseTools()`                       |
| `Model.promptFromFunctions()`                    | `Model.promptFromTools()`                  |
| `Symposium.extractFunctionsFromResponse()`       | `Symposium.extractToolCallsFromResponse()` |

### Provider signature

```javascript
// before
const parsed = this.parseOptions(options, functions);

// after
const parsed = this.parseOptions(options, tools);
```

`parseOptions()` now returns `{options, tools}` (was `{options, functions}`).

### Options

| 2.x                              | 3.0                          |
|----------------------------------|------------------------------|
| `options.functions: [...]`       | `options.tools: [...]`       |
| `options.force_function: 'name'` | `options.force_tool: 'name'` |

### Internal Message content block types

If you build `Message` objects by hand or inspect a thread's history, the content-block tags changed:

| 2.x                                                          | 3.0                                                          |
|--------------------------------------------------------------|--------------------------------------------------------------|
| `{type: 'function', content: [{id, name, arguments}, ...]}`  | `{type: 'tool_call', content: [{id, name, arguments}, ...]}` |
| `{type: 'function_response', content: {name, id, response}}` | `{type: 'tool_result', content: {name, id, response}}`       |

Provider wire formats (e.g. OpenAI's `{type: 'function', function: {...}}` tool-definition shape and `tool_calls[].type = 'function'`) are unchanged — those are the providers' contract, not Symposium's.

### Event payload key

```javascript
// before
if (ev.type === 'tools_auth') {
	const decision = await askUser(ev.functions);
	input.send({ type: 'auth', id: ev.id, decision });
}

// after
if (ev.type === 'tools_auth') {
	const decision = await askUser(ev.tools);
	input.send({ type: 'auth', id: ev.id, decision });
}
```

## C. Mechanical migration

For most consumers, a project-wide find-and-replace covers it:

```
Tool                 →  Toolkit          (class references, imports — careful with the literal string "tool")
extends Tool         →  extends Toolkit
GetContextTool       →  GetContextToolkit
addTool              →  addToolkit
getFunctions         →  getTools
callFunction         →  callTool
parseFunctions       →  parseTools
promptFromFunctions  →  promptFromTools
force_function       →  force_tool
type: 'function'     →  type: 'tool_call'        (only inside Symposium Message content)
type: 'function_response' →  type: 'tool_result' (only inside Symposium Message content)
ev.functions         →  ev.tools                 (only on tools_auth events)
```
