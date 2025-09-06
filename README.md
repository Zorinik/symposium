# Symposium

Symposium is a powerful and flexible Node.js framework for building Large Language Model (LLM)-powered agents. It provides a structured, extensible architecture for creating complex AI systems with distinct behaviors, tools, and memory.

## Features

-   **Agent-Based Architecture**: Create multiple, specialized agents that can be extended with unique behaviors.
-   **Model Agnostic**: Easily integrate with various LLM providers (OpenAI, Anthropic, Groq, etc.). A list of supported models is available in the `models` folder.
-   **Tool Integration**: Extend agents' capabilities by giving them tools to interact with external systems.
-   **Stateful Conversations**: Manages conversational state and history through Threads.
-   **Persistent Memory**: Pluggable storage adapters allow for long-term memory.
-   **Real-time Sessions**: Built-in support for real-time voice conversations.

## Installation

```bash
npm install symposium
```

## Core Concepts

The framework is built around a few core components:

-   **`Symposium`**: A static class that acts as the central hub. It's responsible for loading models and initializing the storage adapter.
-   **`Agent`**: The heart of the framework. An `Agent` is an autonomous entity with a specific goal. You extend this class to define your agent's unique prompt, behavior, and tools.
-   **`Thread`**: Represents a single conversation with an agent. It maintains the message history and the agent's state for that conversation. Each thread has a unique ID.
-   **`Tool`**: A base class for creating tools that an `Agent` can use. Tools expose functions that the LLM can call to interact with external APIs or data.
-   **`Message`**: A wrapper for messages within a `Thread`, containing the role (`user`, `assistant`, `system`, `tool`), content, and other metadata.

## Getting Started

Here's a simple example of how to create a basic chat agent.

### 1. Initialize Symposium

First, you need to initialize `Symposium`. This will load all the available models. You can also provide a storage adapter for persistence.

```javascript
// index.js
import { Symposium } from 'symposium';

async function main() {
	await Symposium.init(); // You can pass a storage adapter here
	// ... your agent code
}

main();
```

### 2. Create your Agent

Create a new class that extends `Agent`. At a minimum, you'll want to define a name and a system prompt.

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

### 3. Start a Conversation

Now you can instantiate your agent and start a conversation.

```javascript
// index.js
import { Symposium } from 'symposium';
import MyChatAgent from './MyChatAgent.js';

async function main() {
	await Symposium.init();

	const agent = new MyChatAgent();
	await agent.init();

	const emitter = await agent.message('Hello, who are you?');

	emitter.on('data', (data) => {
		if (data.type === 'output') {
			process.stdout.write(data.content);
		}
	});

	emitter.on('end', () => {
		console.log('\nConversation ended.');
	});
}

main();
```

When you run this, the agent will respond to your message, and the response will be streamed to the console. The `message` method returns an `EventEmitter` that emits `data` events for text chunks, partial tool usage, and the final response object.

## Advanced Usage

### Using Tools

Tools allow your agent to interact with the outside world. To create a tool, extend the `Tool` class and define one or more functions.

#### 1. Create a Tool

Here's an example of a tool that can get the current weather.

```javascript
// WeatherTool.js
import { Tool } from 'symposium';

export default class WeatherTool extends Tool {
	name = 'WeatherTool';

	async getFunctions() {
		return [
			{
				name: 'get_weather',
				description: 'Get the current weather for a specific city',
				parameters: {
					type: 'object',
					properties: {
						city: {
							type: 'string',
							description: 'The city name',
						},
					},
					required: ['city'],
				},
			},
		];
	}

	async callFunction(thread, name, payload) {
		if (name === 'get_weather') {
			const city = payload.city;
			// In a real app, you would call a weather API here
			return { temperature: '25°C', condition: 'sunny' };
		}
	}
}
```

#### 2. Add the Tool to your Agent

Now, add the tool to your agent instance.

```javascript
// index.js
import MyChatAgent from './MyChatAgent.js';
import WeatherTool from './WeatherTool.js';

// ... inside main()
const agent = new MyChatAgent();
agent.addTool(new WeatherTool());
await agent.init();

const emitter = await agent.message("What's the weather like in Paris?");
// ...
```

The agent's underlying LLM will now be able to see the `get_weather` function and will call it when appropriate, passing the result back into the conversation.

### Switching Models

You can set a default model for an agent or change it on a per-thread basis.

```javascript
// Setting a default model for the agent
class MyAgent extends Agent {
    default_model = 'claude-3-5-sonnet';
    //...
}

// Changing the model for a specific thread
const thread = await agent.getThread('thread-id');
await agent.setModel(thread, 'gpt-3.5-turbo');
```

The model label must be one of the models available in the `models` directory.

### Persistence

Symposium can persist thread state and messages if you provide a storage adapter. The adapter must implement three methods: `init()`, `get(key)`, and `set(key, value)`.

```javascript
// MySimpleFileStorage.js
import fs from 'fs/promises';

class MySimpleFileStorage {
    async init() {
        await fs.mkdir('./storage', { recursive: true });
    }
    async get(key) {
        try {
            const data = await fs.readFile(`./storage/${key}.json`, 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }
    async set(key, value) {
        await fs.writeFile(`./storage/${key}.json`, JSON.stringify(value, null, 2));
    }
}

// index.js
await Symposium.init(new MySimpleFileStorage());
```

With a storage adapter in place, conversations will be saved and loaded automatically based on the thread ID.

### Utility Agents

Besides `chat` agents, you can create `utility` agents. These are designed for specific, one-shot tasks like data extraction or classification, rather than open-ended conversation. They typically return structured JSON.

```javascript
// TextExtractorAgent.js
import { Agent } from 'symposium';

export default class TextExtractorAgent extends Agent {
	name = 'TextExtractorAgent';
	type = 'utility';
	utility = {
		type: 'json',
		function: {
			name: 'extract_data',
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

    async doInitThread(thread) {
        await thread.addMessage('system', 'Extract the name and email from the text.');
    }
}

// Usage
const extractor = new TextExtractorAgent();
await extractor.init();
const result = await extractor.message('My name is John Doe and my email is john.doe@example.com');
console.log(result); // { name: 'John Doe', email: 'john.doe@example.com' }
```

## API Reference

This is a high-level overview. For details, please refer to the source code.

### `Agent`

-   `constructor(options)`: Creates a new agent. Options can include a `memory_handler` or `logger`.
-   `init()`: Initializes the agent. Must be called before use.
-   `addTool(tool)`: Adds a `Tool` instance to the agent.
-   `message(content, thread)`: Sends a message to the agent. Returns an EventEmitter.
-   `getThread(id)`: Retrieves a `Thread` instance by its ID.
-   `setModel(thread, modelLabel)`: Changes the LLM for a specific thread.
-   `createRealtimeSession(thread_id, options)`: Creates a real-time session for voice interaction.

### `Thread`

-   `constructor(id, agent)`: Creates a new thread.
-   `addMessage(role, content, name, tags)`: Adds a message to the thread.
-   `setState(state, save)`: Updates the thread's state object.
-   `loadState()` / `storeState()`: Manages persistence (used internally).

### `Tool`

-   `getFunctions()`: **Abstract**. Must return an array of function definitions that the LLM can call.
-   `callFunction(thread, name, payload)`: **Abstract**. Called when the LLM decides to use one of the tool's functions.

## License

ISC
