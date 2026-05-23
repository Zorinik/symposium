import {v7 as uuid} from 'uuid';

import Symposium from "./Symposium.js";
import Thread from "./Thread.js";
import Toolkit from "./Toolkit.js";
import Context from "./Context.js";
import Text from "./Contexts/Text.js";
import GetContextToolkit from "./GetContextToolkit.js";
import MCPServer from "./MCPServer.js";
import MCPResource from "./Contexts/MCPResource.js";

const CONTROL_TYPES = new Set(['submit', 'cancel', 'auth']);

function isControlMessage(item) {
	if (!item || typeof item !== 'object' || Array.isArray(item))
		return false;
	if (typeof item.type !== 'string')
		return false;
	return CONTROL_TYPES.has(item.type);
}

function isAsyncIterableInput(content) {
	return content !== null
		&& typeof content === 'object'
		&& !Array.isArray(content)
		&& typeof content[Symbol.asyncIterator] === 'function';
}

function normalizeStreamBuffer(items) {
	const blocks = [];
	for (const item of items) {
		if (typeof item === 'string')
			blocks.push({type: 'text', content: item});
		else if (Array.isArray(item))
			blocks.push(...item);
		else if (item && typeof item === 'object')
			blocks.push(item);
	}
	return blocks;
}

function makeNotifier() {
	let resolve;
	let promise = new Promise(r => { resolve = r; });
	return {
		wait() { return promise; },
		signal() {
			const r = resolve;
			promise = new Promise(res => { resolve = res; });
			r();
		},
	};
}

async function isPromiseReady(p) {
	return Promise.race([
		p.then(() => true, () => true),
		new Promise(r => setImmediate(() => r(false))),
	]);
}

export default class Agent {
	name = 'Agent';
	description = null;
	options = {};
	threads;
	tools = null;
	toolkits = new Map();
	context = [];
	default_model = 'gpt-4o';
	max_retries = 5;
	type = 'chat'; // chat, utility
	response_schema = null; // raw JSON schema; when set, final assistant message is parsed against it
	initialized = false;
	enable_image_generation = false;

	constructor(options = {}) {
		this.options = {
			memory_handler: null,
			...options,
		};

		this.threads = new Map();
		this._streamingInputs = new Map();
	}

	async init() {
		if (this.initialized)
			return;

		if (this.options.memory_handler)
			this.options.memory_handler.setAgent(this);

		if (this.response_schema !== null) {
			if (typeof this.response_schema !== 'object' || Array.isArray(this.response_schema))
				throw new Error('response_schema must be a JSON schema object');
			if (typeof this.response_schema.type !== 'string')
				throw new Error('response_schema must declare a top-level "type"');
		}

		this.initialized = true;
	}

	async reset(thread) {
		await thread.flush();
		await this.resetState(thread);
		await this.initThread(thread);
		await thread.storeState();
	}

	async resetState(thread) {
		thread.state = await this.getDefaultState();
		thread.state.model = this.default_model;
	}

	async getDefaultState() {
		return {};
	}

	async addToolkit(toolkit) {
		if (!(toolkit instanceof Toolkit) || !toolkit.name)
			throw new Error('Toolkit must be an instance of Toolkit class');
		if (this.toolkits.has(toolkit.name))
			throw new Error('Toolkit with name ' + toolkit.name + ' already exists in agent');

		await toolkit.init(this);
		this.toolkits.set(toolkit.name, toolkit);
	}

	async addContext(context, options = {}) {
		if (typeof context === 'string')
			context = new Text(context);
		if (!(context instanceof Context))
			throw new Error('Context must be an instance of Context class');

		options = {
			type: 'always', // always, on_request
			description: null,
			...options,
		};

		// TODO: summarization based on tokens
		// TODO: RAG

		const title = await context.getTitle();
		this.context.push({title, context, options});
	}

	async addMCPServer(config) {
		const server = new MCPServer(config);
		await this.addToolkit(server);

		if (config.resources) {
			const resources = await server.listResources();
			for (const res of resources) {
				await this.addContext(new MCPResource(server, res), {
					type: 'on_request',
					description: res.description || '',
				});
			}
		}

		return server;
	}

	async initThread(thread) {
		await this.doInitThread(thread);

		let context_texts = [], is_there_on_request = false;
		for (let {title, context, options} of this.context) {
			switch (options.type) {
				case 'always':
					const text = await context.getText();
					if (text)
						context_texts.push('<context>' + text + '</context>');
					break;

				case 'on_request':
					is_there_on_request = true;
					context_texts.push('<context_on_request><name>' + title + '</name><description>' + options.description + '</description></context_on_request>');
					break;

				default:
					throw new Error('Bad context option type ' + options.type);
			}
		}

		if (context_texts.length) {
			let context_string = context_texts.join('\n\n');
			if (is_there_on_request) {
				context_string = '<important>Some of the context files are available to you immediately here, while longer texts may be available only on request; you are provided with a title and a description of these files. If you think it may be useful for your current task, you can request the text via the get_context tool - IMPORTANT: use the title of the file verbatim as it is provided</important>' + context_string;
				if (!this.toolkits.has('get_context'))
					await this.addToolkit(new GetContextToolkit(this));
			}
			context_string = `<context_info>
${context_string}
</context_info>`;

			let system_message_found = null;
			for (let messages of thread.messages) {
				if (messages.role === 'system')
					system_message_found = messages;
			}

			if (system_message_found)
				system_message_found.content[0].content += context_string;
			else
				thread.addMessage('system', context_string);
		}

		await thread.storeState();
	}

	async doInitThread(thread) {
	}

	async getThread(id = null) {
		if (id === null)
			id = uuid();

		let thread = this.threads.get(id);
		if (!thread) {
			thread = new Thread(id, this);

			if (!(await thread.loadState())) {
				await this.resetState(thread);
				await this.initThread(thread);
			}

			this.threads.set(id, thread);
		}

		return thread;
	}

	message(content, thread = null) {
		if (this.type === 'utility')
			return this._messageAsValue(content, thread);
		return this._messageAsStream(content, thread);
	}

	async _messageAsValue(content, thread) {
		let value;
		for await (const ev of this._messageAsStream(content, thread)) {
			if (ev.type === 'result')
				value = ev.value;
		}
		return value;
	}

	async *_messageAsStream(content, thread = null) {
		if (!this.initialized)
			throw new Error('Agent not initialized');

		if (thread === null)
			thread = uuid();
		if (typeof thread !== 'object')
			thread = await this.getThread(thread);

		if (!isAsyncIterableInput(content)) {
			const model = Symposium.getModel(thread.state.model);
			if (!model.audio && typeof content !== 'string') {
				for (let c of content) {
					if (c.type === 'audio' && !c.content?.transcription) {
						const words = await this.getPromptWordsForTranscription(thread);
						const prompt = words.length ? 'Possibili parole usate: ' + words.join(', ') : null;
						c.content.transcription = await Symposium.transcribe(c.content, prompt);
					}
				}
			}

			await this.log('user_message', content);
			thread.addMessage('user', content);

			yield* this.trigger(thread);
			return;
		}

		const iterator = content[Symbol.asyncIterator]();
		const notifier = makeNotifier();
		const pendingMessages = [];
		const pendingAuthResponses = new Map();
		const controlFlags = {cancelled: false, readerFinished: false};
		const inputState = {streaming: true, pendingMessages, pendingAuthResponses, controlFlags, notifier};
		this._streamingInputs.set(thread.unique, inputState);

		let readerPromise = Promise.resolve();
		let readerStarted = false;

		try {
			const {buffer, iteratorClosed, leftoverNext} = await this._drainInitialInput(iterator, controlFlags);

			if (controlFlags.cancelled) {
				yield {type: 'start', thread};
				yield {type: 'end', thread};
				return;
			}

			if (buffer.length === 0 && iteratorClosed) {
				yield {type: 'start', thread};
				yield {type: 'end', thread};
				return;
			}

			const initialContent = normalizeStreamBuffer(buffer);
			await this._transcribeAudioIfNeeded(thread, initialContent);

			await this.log('user_message', initialContent);
			thread.addMessage('user', initialContent);

			if (!iteratorClosed) {
				readerStarted = true;
				readerPromise = this._runBackgroundReader(iterator, leftoverNext, inputState);
			} else {
				controlFlags.readerFinished = true;
			}

			yield* this.trigger(thread);
		} finally {
			this._streamingInputs.delete(thread.unique);
			if (readerStarted) {
				try {
					if (typeof iterator.return === 'function')
						await iterator.return();
				} catch (e) {}
				try {
					await readerPromise;
				} catch (e) {}
			}
		}
	}

	async _transcribeAudioIfNeeded(thread, blocks) {
		const model = Symposium.getModel(thread.state.model);
		if (model.audio)
			return;
		for (let c of blocks) {
			if (c?.type === 'audio' && !c.content?.transcription) {
				const words = await this.getPromptWordsForTranscription(thread);
				const prompt = words.length ? 'Possibili parole usate: ' + words.join(', ') : null;
				c.content.transcription = await Symposium.transcribe(c.content, prompt);
			}
		}
	}

	async _drainInitialInput(iterator, controlFlags) {
		const buffer = [];
		let iteratorClosed = false;
		let nextPromise = iterator.next();

		while (true) {
			if (buffer.length > 0) {
				const ready = await isPromiseReady(nextPromise);
				if (!ready)
					break;
			}

			let result;
			try {
				result = await nextPromise;
			} catch (e) {
				iteratorClosed = true;
				nextPromise = null;
				throw e;
			}

			if (result.done) {
				iteratorClosed = true;
				nextPromise = null;
				break;
			}

			const item = result.value;
			if (isControlMessage(item)) {
				if (item.type === 'submit') {
					nextPromise = iterator.next();
					break;
				}
				if (item.type === 'cancel') {
					controlFlags.cancelled = true;
					iteratorClosed = true;
					nextPromise = null;
					break;
				}
				nextPromise = iterator.next();
				continue;
			}

			buffer.push(item);
			nextPromise = iterator.next();
		}

		return {buffer, iteratorClosed, leftoverNext: nextPromise};
	}

	async _runBackgroundReader(iterator, leftoverNext, inputState) {
		const {pendingMessages, controlFlags, notifier} = inputState;
		try {
			let pending = leftoverNext;
			while (true) {
				const result = await (pending || iterator.next());
				pending = null;
				if (result.done)
					return;
				const item = result.value;
				if (isControlMessage(item)) {
					if (item.type === 'cancel') {
						controlFlags.cancelled = true;
						notifier.signal();
						return;
					}
					if (item.type === 'auth' && item.id) {
						inputState.pendingAuthResponses.set(item.id, item.decision);
						notifier.signal();
						continue;
					}
					continue;
				}
				pendingMessages.push(item);
				notifier.signal();
			}
		} finally {
			controlFlags.readerFinished = true;
			notifier.signal();
		}
	}

	async _drainPendingMessages(thread) {
		const state = this._streamingInputs.get(thread.unique);
		if (!state || !state.pendingMessages.length)
			return;
		const items = state.pendingMessages.splice(0);
		const content = normalizeStreamBuffer(items);
		await this._transcribeAudioIfNeeded(thread, content);
		await this.log('user_message', content);
		thread.addMessage('user', content);
	}

	async _awaitNextStreamingInput(thread) {
		const state = this._streamingInputs.get(thread.unique);
		if (!state)
			return false;
		while (true) {
			if (state.controlFlags.cancelled)
				return false;
			if (state.pendingMessages.length)
				return true;
			if (state.controlFlags.readerFinished)
				return false;
			await state.notifier.wait();
		}
	}

	async _awaitAuthDecision(thread, id) {
		const state = this._streamingInputs.get(thread.unique);
		if (!state)
			return 'reject';
		while (true) {
			if (state.pendingAuthResponses.has(id)) {
				const decision = state.pendingAuthResponses.get(id);
				state.pendingAuthResponses.delete(id);
				return decision;
			}
			if (state.controlFlags.cancelled)
				return 'reject';
			if (state.controlFlags.readerFinished) {
				state.controlFlags.cancelled = true;
				return 'reject';
			}
			await state.notifier.wait();
		}
	}

	async *trigger(thread = null) {
		if (!this.initialized)
			throw new Error('Agent not initialized');

		if (thread === null)
			thread = uuid();
		if (typeof thread !== 'object')
			thread = await this.getThread(thread);

		yield {type: 'start', thread};
		try {
			yield* this.execute(thread);
		} finally {
			yield {type: 'end', thread};
		}
	}

	async beforeExecute(thread) {
		if (this.options.memory_handler)
			thread = await this.options.memory_handler.handle(thread);
		return thread;
	}

	async *execute(thread) {
		thread = await this.beforeExecute(thread);

		const model = Symposium.getModel(thread.state.model);

		const completion_options = {};
		if (this.response_schema) {
			const schema = this.response_schema;
			const converted = (schema.type === 'object' && model.structured_output)
				? this.convertFunctionToResponseFormat(JSON.parse(JSON.stringify(schema)))
				: null;

			if (converted && converted.count <= 100) { // OpenAI does not support structured output if there are more than 100 parameters
				completion_options.response_format = {
					type: 'json_schema',
					name: 'response',
					schema: converted.obj,
					strict: true,
				};
			} else {
				completion_options.tools = [{
					name: 'response',
					parameters: schema,
				}];
				completion_options.force_tool = 'response';
			}
		}

		const streamingState = this._streamingInputs.get(thread.unique);
		const streaming = !!streamingState;

		let counter = 0;
		let output_yielded = false;
		while (true) {
			if (streaming) {
				await this._drainPendingMessages(thread);
				if (streamingState.controlFlags.cancelled)
					return;
			}

			try {
				// Inline drain of generateCompletion so we can observe `chunk`
				// events and flip output_yielded for the hybrid retry strategy.
				const it = this.generateCompletion(thread, completion_options);
				let step = await it.next();
				let completion;
				while (!step.done) {
					const ev = step.value;
					if (ev?.type === 'chunk')
						output_yielded = true;
					yield ev;
					step = await it.next();
				}
				completion = step.value;

				thread = await this.afterExecute(thread, completion);

				for (let message of completion) {
					if (message.role === 'assistant' && message.content.some(c => c.type === 'reasoning')) {
						const reasoning = message.content.find(c => c.type === 'reasoning').content;
						if (reasoning)
							yield {type: 'reasoning', content: reasoning};
					}
				}

				const verdict = yield* this.handleCompletion(thread, completion);

				if (verdict?.type === 'response') {
					yield {type: 'result', value: verdict.value};
					return;
				}

				switch (this.type) {
					case 'utility':
						throw new Error('Utility agent did not return a response');

					case 'chat':
						if (verdict?.type === 'continue') {
							counter = 0;
							output_yielded = false;
							continue;
						}
						yield {type: 'turn_end', thread};
						if (streaming) {
							const more = await this._awaitNextStreamingInput(thread);
							if (!more)
								return;
							counter = 0;
							output_yielded = false;
							continue;
						}
						return;

					default:
						throw new Error('Bad agent type');
				}
			} catch (e) {
				if (counter < this.max_retries) {
					counter++;
					const reason = e?.message || String(e);
					if (output_yielded)
						yield {type: 'retry', attempt: counter, reason};
					// Preserve the legacy 1-second backoff for transport-level 5xx.
					if (e?.response?.status >= 500)
						await new Promise(resolve => setTimeout(resolve, 1000));
					output_yielded = false;
					continue;
				}
				throw e;
			}
		}
	}

	convertFunctionToResponseFormat(obj) {
		if (obj.type !== 'object')
			return {obj, count: 0};

		let properties_count = 0, required = [];
		for (let [key, property] of Object.entries(obj.properties || {})) {
			properties_count++;
			required.push(key); // OpenAI requires all properties to be required

			if (property.type === 'object') {
				const {obj: subobj, count} = this.convertFunctionToResponseFormat(property);
				obj.properties[key] = subobj;
				properties_count += count;
			} else if (property.type === 'array' && property.items.type === 'object') {
				const {obj: subobj, count} = this.convertFunctionToResponseFormat(property.items);
				obj.properties[key] = {
					type: 'array',
					items: subobj,
				};
				properties_count += count;
			}
		}

		return {
			obj: {
				...obj,
				additionalProperties: false,
				required,
			},
			count: properties_count,
		};
	}

	async afterExecute(thread, completion) {
		return thread;
	}

	async *generateCompletion(thread, options = {}) {
		const model = Symposium.getModel(thread.state.model);
		const it = model.class.generate(model, thread, await this.getTools(), {
			...options,
			image_generation: this.enable_image_generation,
		});

		let messages;
		try {
			let step = await it.next();
			while (!step.done) {
				const delta = step.value;
				if (delta && delta.type === 'text_delta')
					yield {type: 'chunk', content: delta.content};
				step = await it.next();
			}
			messages = step.value;
		} catch (error) {
			// Normalize error shape; the outer execute loop owns retry policy.
			if (error?.response) {
				const normalized = new Error(error.response.status + ': ' + JSON.stringify(error.response.data));
				normalized.response = error.response;
				throw normalized;
			}
			if (error?.message)
				throw new Error(error.message);
			throw error;
		}

		return model.tools ? messages : messages.map(m => this.parseTools(m));
	}

	parseTools(message) {
		const newContent = [];
		for (let m of message.content) {
			if (m.type === 'text' && m.content.match(/```\nCALL [A-Za-z0-9_]+\n[\s\S]*```/)) {
				const splitted = m.content.split('```');
				for (let text of splitted) {
					text = text.trim();
					if (!text)
						continue;

					const match = text.match(/^CALL ([A-Za-z0-9_]+)\n([\s\S]*)$/);
					if (match)
						newContent.push({type: 'tool_call', content: [{name: match[1], arguments: JSON.parse(match[2] || '{}')}]});
					else
						newContent.push({type: 'text', content: text});
				}
			} else {
				newContent.push(m);
			}
		}

		message.content = newContent;
		return message;
	}

	async *handleCompletion(thread, completion) {
		const model = Symposium.getModel(thread.state.model);

		const tool_calls = [];
		for (let message of completion) {
			thread.addDirectMessage(message);
			await this.log('ai_message', message.content);

			for (let m of message.content) {
				switch (m.type) {
					case 'text':
						if (this.response_schema && model.structured_output)
							return {type: 'response', value: await this.afterHandle(thread, completion, JSON.parse(m.content))};
						if (this.type === 'utility' && !this.response_schema)
							return {type: 'response', value: await this.afterHandle(thread, completion, m.content)};

						yield {type: 'output', content: m};
						break;

					case 'image':
						yield {type: 'output', content: m};
						break;

					case 'tool_call':
						for (let t of m.content)
							tool_calls.push(t);
						break;
				}
			}
		}

		if (tool_calls.length) {
			if (this.response_schema)
				return {type: 'response', value: await this.afterHandle(thread, completion, tool_calls[0].arguments)};

			return yield* this.callTools(thread, completion, tool_calls);
		} else {
			await thread.storeState();
			await this.afterHandle(thread, completion);
			return {type: 'void'};
		}
	}

	async *callTools(thread, completion, tools_to_call) {
		const tools = await this.getTools(false);

		let is_authorized = true;
		for (let t of tools_to_call) {
			if (!tools.has(t.name))
				throw new Error('Unrecognized tool ' + t.name);

			if (!(await tools.get(t.name).toolkit.authorize(thread, t.name, t.arguments))) {
				is_authorized = false;
				break;
			}
		}

		if (!is_authorized) {
			const id = uuid();
			yield {type: 'tools_auth', id, tools: tools_to_call};

			const decision = await this._awaitAuthDecision(thread, id);

			if (decision === 'reject')
				return {type: 'void'};

			if (decision === 'approve_always') {
				for (let t of tools_to_call)
					await tools.get(t.name).toolkit.authorizeAlways(thread, t.name, t.arguments);
			} else if (decision !== 'approve') {
				throw new Error('Bad authorization decision: ' + decision);
			}
		}

		const responses = [];
		for (let t of tools_to_call)
			responses.push(yield* this.callTool(thread, tools, t));

		for (let response of responses) {
			thread.addMessage('tool', [
				{
					type: 'tool_result',
					content: {
						name: response.tool_call.name,
						id: response.tool_call.id || undefined,
						response: response.response,
					},
				},
			], response.tool_call.name);

			await this.log('tool_result', response);
		}

		thread.flushPlannedMessages();

		await this.afterHandle(thread, completion);
		return {type: 'continue'};
	}

	async getTools(parsed = true) {
		if (this.tools === null) {
			this.tools = new Map();
			for (let toolkit of this.toolkits.values()) {
				let toolDefs = await toolkit.getTools();
				for (let toolDef of toolDefs) {
					if (this.tools.has(toolDef.name))
						throw new Error('Duplicate tool ' + toolDef.name + ' in agent');

					this.tools.set(toolDef.name, {
						toolkit,
						definition: toolDef,
					});
				}
			}
		}

		if (parsed)
			return Array.from(this.tools.values()).map(e => e.definition)
		else
			return this.tools;
	}

	async *callTool(thread, tools, tool_call) {
		const entry = tools.get(tool_call.name);

		await this.log('tool_call', tool_call);
		yield {type: 'tool', id: tool_call.id, name: tool_call.name, arguments: tool_call.arguments};

		try {
			const response = await entry.toolkit.callTool(thread, tool_call.name, tool_call.arguments);
			yield {type: 'tool_response', id: tool_call.id, name: tool_call.name, toolkit: entry.toolkit.name, success: true, response};

			return {
				type: 'response',
				response,
				tool_call,
			};
		} catch (error) {
			yield {type: 'tool_response', id: tool_call.id, name: tool_call.name, toolkit: entry.toolkit.name, success: false, error: error.message || error};

			return {
				type: 'response',
				response: {error},
				tool_call,
			};
		}
	}

	async afterHandle(thread, completion, value = null) {
		return value;
	}

	async setModel(thread, label) {
		const model_to_switch = Symposium.getModel(label);
		if (model_to_switch && model_to_switch.type === 'llm')
			await thread.setState({model: model_to_switch.name});
		else
			throw new Error("Versione modello non riconosciuta!\nModelli disponibili:\n" + Array.from(Symposium.models.values()).filter(m => m.type === 'llm').map(m => m.label).join("\n"));
	}

	async log(type, payload) {
		if (this.options.logger)
			return this.options.logger.log(this.name, type, payload);
	}

	async getPromptWordsForTranscription(thread) {
		return [this.name];
	}

	// Currently specific for OpenAI Realtime API
	async createRealtimeSession(thread_id = null, options = {}) {
		options = {
			include_thread: true,
			language: 'it',
			...options,
		};

		// If a thread is passed, it is used, otherwise a temporary thread is created
		const thread = await this.getThread(thread_id || uuid());

		const system_message = [], conversation = [];
		for (let message of thread.messages) {
			if (message.role === 'system')
				system_message.push(message.content.map(c => c.content).join("\n"));
			else if (!message.tags?.includes('reasoning'))
				conversation.push('[' + message.role + '] ' + message.content.map(c => (typeof c.content === 'string' ? c.content : (c.content.transcription || JSON.stringify(c.content)))).filter(c => !!c).join("\n"));
		}

		let instructions = system_message.join('\n');
		if (conversation.length && options.include_thread)
			instructions += '\n\n# Ecco la tua conversazione fino ad ora: #\n' + conversation.join('\n');

		const tools = (await this.getTools()).map(t => ({
			type: 'function',
			...t,
		}));

		const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
			method: 'POST',
			headers: {
				"Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
				"Content-Type": 'application/json',
			},
			body: JSON.stringify({
				model: 'gpt-realtime',
				instructions,
				tools,
				input_audio_transcription: {
					model: 'gpt-4o-transcribe',
					language: options.language,
				},
			}),
		}).then(response => response.json());

		if (thread_id === null)
			thread.changeId(response.client_secret.value);

		return {
			response,
			thread,
		};
	}
}
