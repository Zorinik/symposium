import {v7 as uuid} from 'uuid';

import Symposium from "./Symposium.js";
import Thread from "./Thread.js";
import Tool from "./Tool.js";
import Context from "./Context.js";
import Text from "./Contexts/Text.js";
import GetContextTool from "./GetContextTool.js";

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
	functions = null;
	tools = new Map();
	context = [];
	default_model = 'gpt-4o';
	max_retries = 5;
	type = 'chat'; // chat, utility
	utility = null;
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

		if (this.type === 'utility') {
			if (!this.utility || !this.utility.type)
				throw new Error('Utility function not defined');
			if (!['text', 'function', 'json'].includes(this.utility.type))
				throw new Error('Bad utility definition');
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

	async addTool(tool) {
		if (!(tool instanceof Tool) || !tool.name)
			throw new Error('Tool must be an instance of Tool class');
		if (this.tools.has(tool.name))
			throw new Error('Tool with name ' + tool.name + ' already exists in agent');

		await tool.init(this);
		this.tools.set(tool.name, tool);
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
				if (!this.tools.has('get_context'))
					await this.addTool(new GetContextTool(this));
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

	async *message(content, thread = null) {
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
		if (this.type === 'utility') {
			if (['function', 'json'].includes(this.utility.type)) {
				if (!this.utility.function || !this.utility.function.name || !this.utility.function.parameters)
					throw new Error('Bad function definition');

				let response_format = null;
				if (this.utility.type === 'json' && model.structured_output)
					response_format = this.convertFunctionToResponseFormat(this.utility.function.parameters);

				if (response_format && response_format.count <= 100) { // OpenAI does not support structured output if there are more than 100 parameters
					completion_options.response_format = {
						type: 'json_schema',
						name: this.utility.function.name,
						schema: response_format.obj,
						strict: true,
					};
				} else {
					completion_options.functions = [
						this.utility.function,
					];
					completion_options.force_function = this.utility.function.name;
				}
			}
		}

		const streamingState = this._streamingInputs.get(thread.unique);
		const streaming = !!streamingState;

		let counter = 0;
		while (true) {
			if (streaming) {
				await this._drainPendingMessages(thread);
				if (streamingState.controlFlags.cancelled)
					return;
			}

			const completion = yield* this.generateCompletion(thread, completion_options);

			try {
				thread = await this.afterExecute(thread, completion);

				for (let message of completion) {
					if (message.role === 'assistant' && message.content.some(c => c.type === 'reasoning')) {
						const reasoning = message.content.find(c => c.type === 'reasoning').content;
						if (reasoning)
							yield {type: 'reasoning', content: reasoning};
					}
				}

				const verdict = yield* this.handleCompletion(thread, completion);

				switch (this.type) {
					case 'utility':
						if (verdict.type !== 'response')
							throw new Error('Utility agent did not return a response');

						yield {type: 'result', value: verdict.value};
						return;

					case 'chat':
						if (verdict?.type === 'continue') {
							counter = 0;
							continue;
						}
						if (streaming) {
							const more = await this._awaitNextStreamingInput(thread);
							if (!more)
								return;
							counter = 0;
							continue;
						}
						return;

					default:
						throw new Error('Bad agent type');
				}
			} catch (e) {
				console.error(e);

				if (counter < this.max_retries) {
					counter++;
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

	async *generateCompletion(thread, options = {}, retry_counter = 1) {
		const model = Symposium.getModel(thread.state.model);
		const it = model.class.generate(model, thread, await this.getFunctions(), {
			...options,
			image_generation: this.enable_image_generation,
		});

		let messages;
		let yielded = false;
		try {
			let step = await it.next();
			while (!step.done) {
				const delta = step.value;
				if (delta && delta.type === 'text_delta') {
					yield {type: 'chunk', content: delta.content};
					yielded = true;
				}
				step = await it.next();
			}
			messages = step.value;
		} catch (error) {
			// Retry transport-level errors only if we haven't yielded any chunk yet.
			if (!yielded && error.response) {
				console.error(error.response.status);
				console.error(error.response.data);

				if (error.response.status >= 500 && retry_counter <= this.max_retries) {
					await new Promise(resolve => setTimeout(resolve, 1000));
					return yield* this.generateCompletion(thread, options, retry_counter + 1);
				}

				throw new Error(error.response.status + ': ' + JSON.stringify(error.response.data));
			}
			if (!yielded && error.message)
				throw new Error(error.message);
			if (!yielded)
				throw new Error('Errore interno');
			throw error;
		}

		return model.tools ? messages : messages.map(m => this.parseFunctions(m));
	}

	parseFunctions(message) {
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
						newContent.push({type: 'function', content: [{name: match[1], arguments: JSON.parse(match[2] || '{}')}]});
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

		const functions = [];
		for (let message of completion) {
			thread.addDirectMessage(message);
			await this.log('ai_message', message.content);

			for (let m of message.content) {
				switch (m.type) {
					case 'text':
						if (this.type === 'utility') {
							if (this.utility.type === 'text')
								return {type: 'response', value: await this.afterHandle(thread, completion, m.content)};
							if (this.utility.type === 'json' && model.structured_output)
								return {type: 'response', value: await this.afterHandle(thread, completion, JSON.parse(m.content))};
						}

						yield {type: 'output', content: m};
						break;

					case 'image':
						yield {type: 'output', content: m};
						break;

					case 'function':
						for (let f of m.content)
							functions.push(f);
						break;
				}
			}
		}

		if (functions.length) {
			if (this.utility && ['function', 'json'].includes(this.utility.type))
				return {type: 'response', value: await this.afterHandle(thread, completion, functions[0].arguments)};

			return yield* this.callFunctions(thread, completion, functions);
		} else {
			await thread.storeState();
			await this.afterHandle(thread, completion);
			return {type: 'void'};
		}
	}

	async *callFunctions(thread, completion, functions_to_call) {
		const functions = await this.getFunctions(false);

		let is_authorized = true;
		for (let f of functions_to_call) {
			if (!functions.has(f.name))
				throw new Error('Unrecognized function ' + f.name);

			if (!(await functions.get(f.name).tool.authorize(thread, f.name, f.arguments))) {
				is_authorized = false;
				break;
			}
		}

		if (!is_authorized) {
			const id = uuid();
			yield {type: 'tools_auth', id, functions: functions_to_call};

			const decision = await this._awaitAuthDecision(thread, id);

			if (decision === 'reject')
				return {type: 'void'};

			if (decision === 'approve_always') {
				for (let f of functions_to_call)
					await functions.get(f.name).tool.authorizeAlways(thread, f.name, f.arguments);
			} else if (decision !== 'approve') {
				throw new Error('Bad authorization decision: ' + decision);
			}
		}

		const responses = [];
		for (let f of functions_to_call)
			responses.push(yield* this.callFunction(thread, functions, f));

		for (let response of responses) {
			thread.addMessage('tool', [
				{
					type: 'function_response',
					content: {
						name: response.function.name,
						id: response.function.id || undefined,
						response: response.response,
					},
				},
			], response.function.name);

			await this.log('function_response', response);
		}

		thread.flushPlannedMessages();

		await this.afterHandle(thread, completion);
		return {type: 'continue'};
	}

	async getFunctions(parsed = true) {
		if (this.functions === null) {
			this.functions = new Map();
			for (let tool of this.tools.values()) {
				let functions = await tool.getFunctions();
				for (let func of functions) {
					if (this.functions.has(func.name))
						throw new Error('Duplicate function ' + func.name + ' in agent');

					this.functions.set(func.name, {
						tool,
						function: func,
					});
				}
			}
		}

		if (parsed)
			return Array.from(this.functions.values()).map(f => f.function)
		else
			return this.functions;
	}

	async *callFunction(thread, functions, function_call) {
		const function_definition = functions.get(function_call.name);

		await this.log('function_call', function_call);
		yield {type: 'tool', id: function_call.id, name: function_call.name, arguments: function_call.arguments};

		try {
			const response = await function_definition.tool.callFunction(thread, function_call.name, function_call.arguments);
			yield {type: 'tool_response', name: function_definition.tool.name, success: true, response};

			return {
				type: 'response',
				response,
				function: function_call,
			};
		} catch (error) {
			yield {type: 'tool_response', name: function_definition.tool.name, success: false, error: error.message || error};

			return {
				type: 'response',
				response: {error},
				function: function_call,
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

		const tools = (await this.getFunctions()).map(t => ({
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
