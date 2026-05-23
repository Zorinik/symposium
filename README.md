# Symposium

Symposium is a Node.js framework for building Large Language Model (LLM)-powered agents. It provides a structured, extensible architecture for creating complex AI systems with distinct behaviors, tools, and memory.

> **3.0 is a breaking release.** The old `EventEmitter` API is gone, replaced by async generators and streaming input channels. See [MIGRATION.md](./MIGRATION.md) for upgrade instructions.

## Features

-	**Agent-Based Architecture**: Create multiple, specialized agents that can be extended with unique behaviors.
-	**Model Agnostic**: Easily integrate with various LLM providers (OpenAI, Anthropic, Groq, DeepSeek, Grok, Ollama). A list of supported models is available in the `Models` folder.
-	**Real streaming**: Model adapters use the underlying providers' streaming APIs and forward token deltas to consumers as they arrive.
-	**Async generator API**: `agent.message(...)` returns an async iterable — consume it with `for await`.
-	**Streaming input**: Push user messages, tool-authorization decisions, and control signals into a running agent via an input channel.
-	**Tool integration**: Extend agents' capabilities with tools that the LLM can call.
-	**Stateful conversations**: Manage conversational state and history through Threads.
-	**Persistent memory**: Pluggable storage adapters allow for long-term memory.
-	**Structured output**: Set `response_schema` on any agent (chat or utility) to constrain the final answer to a JSON schema.
-	**Real-time sessions**: Built-in support for real-time voice conversations.

## Installation

Requires Node.js v18 or higher.

```bash
npm install symposium
```

## Configuration

Symposium uses environment variables to configure access to various services. You can set these in a `.env` file at the root of your project.

-	`OPENAI_API_KEY`: Required for OpenAI models and real-time voice sessions.
-	`ANTHROPIC_API_KEY`: Required for Anthropic models.
-	`GROQ_API_KEY`: Required for Groq models.
-	`DEEPSEEK_API_KEY`: Required for DeepSeek models.
-	`TRANSCRIPTION_MODEL`, `EMBEDDING_MODEL`: Model labels routed to STT / embedding providers.

## Core Concepts

-	**`Symposium`**: Static class that acts as the central hub. Responsible for loading models and initializing the storage adapter.
-	**`Agent`**: The heart of the framework. Extend this class to define an agent's prompt, behavior, and tools.
-	**`Thread`**: A single conversation with an agent. Maintains message history and per-conversation state.
-	**`Tool`**: Base class for tools that an `Agent` can call.
-	**`Message`**: A typed message inside a `Thread`.
-	**`ContextHandler`** / **`Summarizer`**: Pre-execute hooks for managing long-context strategies.
-	**`createInputChannel`**: Helper that creates an `AsyncIterable` with `send(item)` / `close()` for streaming input into an agent.

## Getting Started

### 1. Initialize Symposium

```javascript
import { Symposium } from 'symposium';

await Symposium.init(); // optional: pass a storage adapter
```

### 2. One-shot prompts

`Symposium.prompt(system, prompt, options)` is a shortcut that spins up a bare utility agent and resolves directly to the final value.

```javascript
import { Symposium } from 'symposium';
await Symposium.init();

const reply = await Symposium.prompt(
	'Translate from English to French.',
	'Hello, how are you?',
);
console.log(reply); // "Bonjour, comment ça va ?"

// With structured output:
const data = await Symposium.prompt(
	'Extract name and emails from the following text',
	email_text,
	{
		response_schema: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					email: { type: 'string' },
				},
				required: ['name', 'email'],
			},
		},
	},
);
```

### 3. Create your Agent

```javascript
// MyChatAgent.js
import { Agent } from 'symposium';

export default class MyChatAgent extends Agent {
	name = 'MyChatAgent';
	description = 'A simple chat agent.';

	async doInitThread(thread) {
		await thread.addMessage('system', 'You are a helpful assistant.');
	}
}
```

### 4. Start a Conversation

`agent.message()` returns an async generator. Consume it with `for await`.

```javascript
import { Symposium } from 'symposium';
import MyChatAgent from './MyChatAgent.js';

await Symposium.init();

const agent = new MyChatAgent();
await agent.init();

for await (const ev of agent.message('Hello, who are you?')) {
	switch (ev.type) {
		case 'chunk':
			process.stdout.write(ev.content); // streamed text delta
			break;

		case 'output':
			// Final assembled content block for this assistant turn.
			// ev.content is a typed block ({type:'text'|'image', ...}).
			break;

		case 'reasoning':
			// Reasoning text from models that emit it (o-series, Claude thinking, etc.).
			break;

		case 'tool':
			console.log(`\n> Using tool: ${ev.name}(${JSON.stringify(ev.arguments)})`);
			break;

		case 'tool_response':
			if (ev.success)
				console.log(`> ${ev.name} OK: ${JSON.stringify(ev.response)}`);
			else
				console.log(`> ${ev.name} FAILED: ${ev.error}`);
			break;
	}
}
```

#### Event reference

All events yielded from the generator:

| Event | Payload | Notes |
|---|---|---|
| `start` | `{thread}` | First yield. |
| `chunk` | `{content}` | Streamed text delta — concatenate to render incrementally. |
| `output` | `{content}` | Final assembled content block (`text` / `image`) for one assistant message. |
| `reasoning` | `{content}` | Reasoning text. |
| `tool` | `{id, name, arguments}` | Emitted before invoking a tool. |
| `tool_response` | `{name, success, response?, error?}` | Emitted after the tool returns or throws. |
| `tools_auth` | `{id, functions}` | Yielded when authorization is required — see below. |
| `retry` | `{attempt, reason}` | Only when an error occurs *after* at least one chunk has already streamed for the current turn. |
| `result` | `{value}` | Only when `response_schema` is set — parsed structured answer. |
| `end` | `{thread}` | Always yielded last, even on throw. |

Errors throw out of the generator. There is no `error` event.

## Advanced Usage

### Using Tools

Tools allow your agent to interact with the outside world. Extend `Tool` and expose one or more functions.

```javascript
// WeatherTool.js
import { Tool } from 'symposium';

export default class WeatherTool extends Tool {
	name = 'WeatherTool';

	async getFunctions() {
		return [{
			name: 'get_weather',
			description: 'Get the current weather for a specific city',
			parameters: {
				type: 'object',
				properties: {
					city: { type: 'string', description: 'The city name' },
				},
				required: ['city'],
			},
		}];
	}

	async callFunction(thread, name, payload) {
		if (name === 'get_weather')
			return { temperature: '25°C', condition: 'sunny' };
	}
}
```

Add the tool to your agent:

```javascript
const agent = new MyChatAgent();
await agent.addTool(new WeatherTool());
await agent.init();

for await (const ev of agent.message("What's the weather in Paris?")) {
	// ...
}
```

Tools within a single LLM turn are executed sequentially, in the order the model requested them, so the event stream is fully deterministic.

### Tool Authorization

To require explicit approval for a tool, override `Tool.authorize()`. When it returns `false`, the agent yields a `tools_auth` event and suspends. The consumer resumes the run by sending an `auth` control message through the input channel.

```javascript
import { Tool } from 'symposium';

class DangerousTool extends Tool {
	async authorize(thread, name, payload) {
		return false; // always ask
	}
	async authorizeAlways(thread, name, payload) {
		// Persist an "always approve" decision somewhere (DB, file, etc.).
	}
	// ... getFunctions / callFunction
}
```

```javascript
import { createInputChannel } from 'symposium';

const input = createInputChannel();
input.send('Please run that risky operation');

for await (const ev of agent.message(input)) {
	if (ev.type === 'tools_auth') {
		const decision = await askUser(ev.functions); // 'approve' | 'approve_always' | 'reject'
		input.send({ type: 'auth', id: ev.id, decision });
	}
}
```

`'approve_always'` calls `tool.authorizeAlways()` on each pending function so the decision is persisted. If the input channel closes while a `tools_auth` is pending, the decision is treated as `'reject'` and the run is cancelled. If you call `agent.message()` with a plain string (no channel), any auth request auto-rejects, since there is no way to deliver a decision.

### Streaming Input

`agent.message()` accepts three input shapes:

1.	a plain `string`,
2.	a `ContentBlock[]` (e.g. text + image),
3.	an `AsyncIterable<string | ContentBlock | ContentBlock[] | ControlMessage>`.

The first two behave traditionally — one user turn, one model loop, done. An async iterable enables **streaming input**: keep pushing messages into the agent at any time.

```javascript
import { createInputChannel } from 'symposium';

const input = createInputChannel();
input.send('Plan a trip to Rome');

// Concurrently, from elsewhere:
setTimeout(() => input.send('Actually, make it Florence instead'), 2000);

for await (const ev of agent.message(input)) {
	if (ev.type === 'chunk')
		process.stdout.write(ev.content);
}

// When you're done, close the channel to end the run:
input.close();
```

Behavior with a channel:

-	The agent drains incoming items into the initial user message and starts the first model turn once content has arrived (or once a `{type:'submit'}` control message lands).
-	New items pushed during a turn are queued and inserted as a new `user` message at the next inter-turn boundary (after the current tool batch finishes — there is no mid-turn cancellation).
-	The run keeps going across multiple turns until the channel closes, or a `{type:'cancel'}` control message is sent.

Control messages accepted on the channel:

```js
{ type: 'auth',   id, decision: 'approve' | 'approve_always' | 'reject' }
{ type: 'submit' }    // closes the initial user-message build-up
{ type: 'cancel' }    // gracefully stops the agent loop after the in-flight turn
```

### Structured Output

`response_schema` is independent of the agent type — set it on either a chat or utility agent to constrain the final answer.

**Utility agent** — `await agent.message(...)` resolves directly to the parsed value:

```javascript
// TextExtractorAgent.js
import { Agent } from 'symposium';

export default class TextExtractorAgent extends Agent {
	name = 'TextExtractorAgent';
	type = 'utility';
	response_schema = {
		type: 'object',
		properties: {
			name: { type: 'string' },
			email: { type: 'string' },
		},
		required: ['name', 'email'],
	};

	async doInitThread(thread) {
		await thread.addMessage('system', 'Extract the name and email from the text.');
	}
}

const extractor = new TextExtractorAgent();
await extractor.init();
const result = await extractor.message('My name is John Doe, john.doe@example.com');
console.log(result); // { name: 'John Doe', email: 'john.doe@example.com' }
```

**Chat agent with structured final answer** — events stream normally; a final `{type:'result', value}` event carries the parsed object just before `end`:

```javascript
const agent = new MyChatAgent();
agent.response_schema = {
	type: 'object',
	properties: { city: { type: 'string' } },
	required: ['city'],
};
await agent.init();

for await (const ev of agent.message('Look up the weather and reply in JSON')) {
	if (ev.type === 'result')
		console.log(ev.value); // { city: '...' }
}
```

Internally, structured-output-capable OpenAI models use `response_format: json_schema`; otherwise the agent falls back to a forced function call and parses its arguments.

### Real-time Voice and Transcription

Symposium has built-in support for audio transcription and real-time voice sessions, currently powered by OpenAI.

```javascript
// Inline audio in a message — automatically transcribed if the model doesn't accept audio:
for await (const ev of agent.message([
	{
		type: 'audio',
		content: { type: 'url', data: 'http://example.com/audio.mp3' },
	},
])) {
	// ...
}

// Standalone transcription:
const text = await Symposium.transcribe(audio_buffer);

// Real-time voice session:
const { response, thread } = await agent.createRealtimeSession();
const sessionId = response.id;
const clientSecret = response.client_secret.value;
```

### Switching Models

```javascript
class MyAgent extends Agent {
	default_model = 'claude-3-5-sonnet';
	// ...
}

const thread = await agent.getThread('thread-id');
await agent.setModel(thread, 'gpt-5');
```

### Persistence

Provide a storage adapter implementing `init()`, `get(key)`, `set(key, value)`:

```javascript
import fs from 'fs/promises';

class FileStorage {
	async init() {
		await fs.mkdir('./storage', { recursive: true });
	}
	async get(key) {
		try {
			return JSON.parse(await fs.readFile(`./storage/${key}.json`, 'utf-8'));
		} catch {
			return null;
		}
	}
	async set(key, value) {
		await fs.writeFile(`./storage/${key}.json`, JSON.stringify(value, null, 2));
	}
}

await Symposium.init(new FileStorage());
```

### Retries

The agent retries each turn up to `max_retries` (default 5) times on transport / model errors. The retry strategy is hybrid:

-	If no `chunk` has been streamed yet for the current turn, the retry is **silent** (no consumer-visible event).
-	If at least one `chunk` has already been streamed, the agent yields `{type:'retry', attempt, reason}` before retrying so consumers can react (e.g. show a spinner, clear partial output).

Errors during *tool* execution are not retried — they're surfaced as `{type:'tool_response', success:false, error}`.

## API Reference

High-level overview — see source for full details.

### `Agent`

-	`constructor(options)` — Optional `memory_handler` and `logger`.
-	`init()` — Must be called before use.
-	`addTool(tool)` — Add a `Tool` instance.
-	`message(content, thread)` — Send a message. Returns an async generator for chat agents; resolves to the parsed value (Promise) for utility agents.
-	`getThread(id)` — Retrieve a `Thread` instance.
-	`setModel(thread, modelLabel)` — Change the LLM for a thread.
-	`createRealtimeSession(thread_id, options)` — Create a real-time voice session.

### `Thread`

-	`constructor(id, agent)`
-	`addMessage(role, content, name, tags)`
-	`setState(state, save)`
-	`loadState()` / `storeState()`

### `Tool`

-	`getFunctions()` — Abstract. Return an array of function definitions for the LLM.
-	`callFunction(thread, name, payload)` — Abstract. Called when the LLM invokes one of the tool's functions.
-	`authorize(thread, name, payload)` — Optional. Return `false` to require explicit consumer approval (`tools_auth` event).
-	`authorizeAlways(thread, name, payload)` — Optional. Called when the consumer responds with `'approve_always'`.

### `createInputChannel()`

Returns `{ send(item), close(), [Symbol.asyncIterator]() }`. Push strings, content blocks, or control messages from anywhere; iterate the channel from `agent.message()`.

### Other Classes

-	**`ContextHandler`**: Base for managing long-term context.
-	**`Summarizer`**: Utility agent that compresses old messages once a thread crosses a token threshold.
-	**`Logger`**: Simple per-agent logger.

## License

ISC
