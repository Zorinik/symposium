import {v7 as uuid} from 'uuid';

import BufferedEventEmitter from "./BufferedEventEmitter.js";

import Symposium from "./Symposium.js";
import Thread from "./Thread.js";

export default class Agent {
	name = 'Agent';
	description = null;
	options = {};
	threads;
	functions = null;
	tools = new Map();
	default_model = 'gpt-4o';
	max_retries = 5;
	type = 'chat'; // chat, utility
	utility = null;
	initialized = false;

	constructor(options) {
		this.options = {
			memory_handler: null,
			...options,
		};

		this.threads = new Map();
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
		thread.state.model = Symposium.getModelByLabel(this.default_model).name;
	}

	async getDefaultState() {
		return {};
	}

	addTool(tool) {
		this.tools.set(tool.name, tool);
	}

	async initThread(thread) {
		await this.doInitThread(thread);
		await thread.storeState();
	}

	async doInitThread(thread) {
	}

	async getThread(id) {
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

	async message(content, thread = null) {
		if (!this.initialized)
			throw new Error('Agent not initialized');

		if (thread === null)
			thread = uuid();
		if (typeof thread !== 'object')
			thread = await this.getThread(thread);

		const model = Symposium.getModelByName(thread.state.model);
		if (!model.supports_audio && typeof content !== 'string') {
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

		return this.execute(thread);
	}

	async beforeExecute(thread, emitter) {
		if (this.options.memory_handler)
			thread = await this.options.memory_handler.handle(thread);
		return thread;
	}

	async execute(thread, counter = 0, existing_emitter = null) {
		const emitter = existing_emitter || new BufferedEventEmitter();

		const execution = new Promise(async (resolve, reject) => {
			try {
				if (counter === 0)
					thread = await this.beforeExecute(thread, emitter);

				const model = Symposium.getModelByName(thread.state.model);

				const completion_options = {};
				if (this.type === 'utility') {
					if (['function', 'json'].includes(this.utility.type)) {
						if (!this.utility.function || !this.utility.function.name || !this.utility.function.parameters)
							throw new Error('Bad function definition');

						let response_format = null;
						if (this.utility.type === 'json' && model.supports_structured_output)
							response_format = this.convertFunctionToResponseFormat(this.utility.function.parameters);

						if (response_format && response_format.count <= 100) { // OpenAI does not support structured output if there are more than 100 parameters
							completion_options.response_format = {
								type: 'json_schema',
								json_schema: {
									name: this.utility.function.name,
									schema: response_format.obj,
									strict: true,
								},
							};
						} else {
							completion_options.functions = [
								this.utility.function,
							];
							completion_options.force_function = this.utility.function.name;
						}
					}
				}

				let completion;
				try {
					completion = await this.generateCompletion(thread, completion_options);
				} catch (e) {
					console.error(e.message);
					switch (this.type) {
						case 'chat':
							emitter.emit('error', e.message);
							return resolve(e);

						case 'utility':
							throw e;

						default:
							throw new Error('Bad agent type');
					}
				}

				try {
					thread = await this.afterExecute(thread, completion, emitter);
					const response = await this.handleCompletion(thread, completion, emitter);

					switch (this.type) {
						case 'utility':
							if (response.type !== 'response')
								throw new Error('Utility agent did not return a response');

							return resolve(response.value);

						case 'chat':
							if (response?.type === 'continue')
								return this.execute(thread, 0, emitter);

							return resolve(null);

						default:
							throw new Error('Bad agent type');
					}
				} catch (e) {
					console.error(e);

					if (counter < this.max_retries)
						await this.execute(thread, counter + 1, emitter);
				}
			} catch (e) {
				reject(e);
			}
		});

		return this.type === 'chat' ? emitter : execution;
	}

	convertFunctionToResponseFormat(obj) {
		if (obj.type !== 'object')
			return {obj, count: 0};

		let properties_count = 0, all_required = false, required = [];
		if (obj.required)
			required = obj.required;
		else
			all_required = true;

		for (let [key, property] of Object.entries(obj.properties || {})) {
			properties_count++;
			if (all_required)
				required.push(key);

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

	async afterExecute(thread, completion, emitter) {
		return thread;
	}

	async generateCompletion(thread, options = {}, retry_counter = 1) {
		try {
			const model = Symposium.getModelByName(thread.state.model);
			const messages = await model.generate(thread, await this.getFunctions(), options);
			return model.supports_functions ? messages : messages.map(m => this.parseFunctions(m));
		} catch (error) {
			if (error.response) {
				console.error(error.response.status);
				console.error(error.response.data);

				if (error.response.status >= 500 && retry_counter <= this.max_retries) {
					await new Promise(resolve => {
						setTimeout(resolve, 1000);
					});

					return this.generateCompletion(thread, options, retry_counter + 1);
				}

				throw new Error(error.response.status + ': ' + JSON.stringify(error.response.data));
			} else if (error.message) {
				throw new Error(error.message);
			} else {
				throw new Error('Errore interno');
			}
		}
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

	async handleCompletion(thread, completion, emitter) {
		const model = Symposium.getModelByName(thread.state.model);

		const functions = [];
		for (let message of completion) {
			thread.addDirectMessage(message);
			await this.log('ai_message', message.content);

			for (let m of message.content) {
				switch (m.type) {
					case 'text':
						if (this.type === 'utility') {
							if (this.utility.type === 'text')
								return {type: 'response', value: this.afterHandle(thread, completion, m.content)};
							if (this.utility.type === 'json' && model.supports_structured_output)
								return {type: 'response', value: this.afterHandle(thread, completion, JSON.parse(m.content))};
						}

						emitter.emit('output', m.content);
						break;

					case 'function':
						for (let f of m.content)
							functions.push(f);
						break;
				}
			}
		}

		if (functions.length) {
			for (let f of functions) {
				if (this.utility && ['function', 'json'].includes(this.utility.type))
					return {type: 'response', value: this.afterHandle(thread, completion, f.arguments)};

				const function_response = await this.callFunction(thread, f, emitter);

				thread.addMessage('tool', [
					{
						type: 'function_response',
						content: {name: f.name, response: function_response, id: f.id || undefined},
					},
				], f.name);

				await this.log('function_response', function_response);
			}

			await this.afterHandle(thread, completion);
			return {type: 'continue'};
		} else {
			await thread.storeState();
			await this.afterHandle(thread, completion);
			return {type: 'void'};
		}
	}

	async afterHandle(thread, completion, value = null) {
		return value;
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

	async callFunction(thread, function_call, emitter) {
		const functions = await this.getFunctions(false);
		if (!functions.has(function_call.name))
			throw new Error('Unrecognized function ' + function_call.name);

		const func = functions.get(function_call.name);
		const partialOutput = func.partialOutput ? ((typeof func.partialOutput) === 'text' ? func.partialOutput : func.partialOutput.call(this, function_call.arguments)) : 'Uso lo strumento ' + function_call.name + '...';
		emitter.emit('partial', partialOutput);

		await this.log('function_call', function_call);

		try {
			const response = await func.tool.callFunction(thread, function_call.name, function_call.arguments);
			emitter.emit('partial', 'Risposta ricevuta da ' + func.tool.name);
			return response;
		} catch (error) {
			emitter.emit('partial', 'Ricevuto errore da ' + func.tool.name);
			return {error};
		}
	}

	async setModel(thread, label) {
		const model_to_switch = Symposium.getModelByLabel(label);
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
