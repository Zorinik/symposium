# Symposium

Symposium is an npm library designed to simplify the deployment and management of AI agents. Its modular and flexible architecture makes it easy to create agents that can interact with users, execute functions through integrated tools, and manage complex conversation threads—all while supporting multiple language models from various providers.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Supported Models](#supported-models)
- [Extending Symposium](#extending-symposium)
- [Examples](#examples)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Symposium provides a robust framework for deploying AI agents with ease. It handles message threading, state management, logging, and even conversation summarization to keep interactions within token limits. With built-in support for multiple AI models and a plugin-like system for tools, Symposium enables developers to quickly build sophisticated agent-based applications.

---

## Features

- **Agent Management**: Create and manage agents that process user messages and execute actions.
- **Tool Integration**: Extend your agents’ capabilities by integrating custom tools with defined functions.
- **Thread & Memory Handling**: Manage conversation state and threads seamlessly, with automatic summarization support.
- **Multi-Agent Coordination**: Support for multi-agent systems to allow agents to collaborate and share tasks.
- **Flexible Model Support**: Out-of-the-box compatibility with various models including OpenAI, Anthropic, Groq, and DeepSeek.
- **Structured Function Calls**: Enable agents to call functions using structured output, ensuring clarity and consistency.

---

## Installation

Install Symposium via npm:

```bash
npm install symposium
```

---

## Usage

Below is a basic example of how to create a custom agent using Symposium:

```js
import { Symposium, Agent } from 'symposium';

class MyAgent extends Agent {
  constructor(options = {}) {
    super(options);
    this.name = 'MyAgent';
  }

  async doInitThread(thread) {
    await thread.addMessage('system', 'Welcome! How can I assist you today?');
  }
}

(async () => {
  const myAgent = new MyAgent();
  await myAgent.init();
  
  const thread = await myAgent.getThread('example-thread');
  await myAgent.message(thread, 'default', 'Hello, agent!');
})();
```

---

## Architecture

Symposium is built around several core components:

- **Agent**: The base class for creating agents. Agents process messages, manage threads, and interact with tools.
- **Tool**: Extend functionality by integrating custom functions. Tools define their own functions and provide implementations through the `callFunction` method.
- **Thread**: Represents a conversation, handling message storage, state management, and persistence.
- **Logger & MemoryHandler**: Utilities for logging events and managing conversation memory, respectively.
- **Summarizer**: A specialized memory handler that summarizes conversation threads to maintain context within token limits.
- **Interface**: Abstracts output and error handling, enabling custom integrations with external systems.

---

## Supported Models

Symposium supports a variety of AI models, allowing you to switch between them based on your needs:

- **OpenAI Models**:
    - GPT-3.5-turbo
    - GPT-4, GPT-4Turbo, GPT-4o
    - GPT-o1, GPT-o1 mini
- **Anthropic Models**:
    - Claude3 variants (Haiku, Sonnet, Opus, and 3.5 Sonnet)
- **Groq Models**:
    - Llama3, Mixtral8
- **DeepSeek Models**:
    - DeepSeekChat, DeepSeekReasoner
- **Other Models**:
    - Whisper (for speech-to-text)

These models are encapsulated in their own modules, and you can easily switch the active model by updating the conversation thread state.

---

## Extending Symposium

Symposium is designed to be extended and customized:

- **Creating Custom Agents**: Inherit from the `Agent` class and override methods like `doInitThread` and `message` to implement custom behavior.
- **Implementing Tools**: Build your own tools by extending the `Tool` class. Define the functions your tool exposes and provide implementations via `callFunction`.
- **Custom Memory Handlers & Loggers**: Implement your own memory or logging strategies by creating classes that adhere to the respective interfaces.
- **Defining Interfaces**: Customize output and error handling by implementing your own `Interface` classes.

---

## Examples

The repository includes an `examples` folder with sample implementations demonstrating:

- **ChatAgent**: A basic conversational agent.
- **MultiAgent**: An agent that coordinates with other agents via internal interfaces.
- **TitlerAgent**: An agent that generates concise titles for conversations.
- **Tools**: Examples like `GenericTool` and `MultiAgentTool` show how to integrate custom functionality.

> **Important:** The content in the `examples` folder is provided solely for demo purposes and will not be part of the exported npm package. You can use these examples as a guide for building your own implementations.

---

## Contributing

Contributions to Symposium are welcome! If you have ideas, improvements, or bug fixes, please fork the repository and submit a pull request.

---

## License

Symposium is released under the ISC License.

---

Developed by **Domenico Giambra**

For more details or to report issues, please refer to the repository's issue tracker. Enjoy building your AI-driven applications with Symposium!
