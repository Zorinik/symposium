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
	callbacks = {};
	utility = null;

	constructor(options) {
		this.options = {
			memory_handler: null,
			interfaces: [],
			...options,
		};

		this.threads = new Map();
	}

	async init() {
		for (let i of this.options.interfaces)
			await i.init(this);

		if (this.options.memory_handler)
			this.options.memory_handler.setAgent(this);
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

	async getThread(id, i = 'default') {
		let thread = this.threads.get(id);
		if (thread) {
			if (thread.interface !== i)
				throw new Error('Required thread is not from the same interface');
		} else {
			thread = new Thread(id, i, this);

			if (!(await thread.loadState())) {
				await this.resetState(thread);
				await this.initThread(thread);
			}

			this.threads.set(id, thread);
		}

		return thread;
	}

	async message(thread, i, content, callback = null) {
		if (typeof thread !== 'object')
			thread = await this.getThread(thread, i);

		if (callback) {
			if (!this.callbacks.hasOwnProperty(i + '-' + thread.id))
				this.callbacks[i + '-' + thread.id] = [];
			this.callbacks[i + '-' + thread.id].push(callback);
		}

		await this.log('user_message', content);
		thread.addMessage('user', content);

		return this.execute(thread);
	}

	async beforeExecute(thread) {
		if (this.options.memory_handler)
			thread = await this.options.memory_handler.handle(thread);
		return thread;
	}

	async execute(thread, counter = 0) {
		if (counter === 0)
			thread = await this.beforeExecute(thread);

		const model = Symposium.getModelByName(thread.state.model);

		const completion_options = {};
		if (this.utility) {
			if (!['text', 'function', 'json'].includes(this.utility.type))
				throw new Error('Bad utility definition');

			if (['function', 'json'].includes(this.utility.type)) {
				if (!this.utility.function || !this.utility.function.name || !this.utility.function.parameters)
					throw new Error('Bad function definition');

				let response_format = null;
				if (this.utility.type === 'json' && model.supports_structured_output)
					response_format = this.convertFunctionToResponseFormat(this.utility.function.parameters);

				if (response_format && response_format.count <= 100) { // Se ci sono più di 100 parametri, OpenAI non supporta gli structured output
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

		const completion = await this.generateCompletion(thread, completion_options);
		if (completion) {
			try {
				thread = await this.afterExecute(thread, completion);
				const response = await this.handleCompletion(thread, completion);
				switch (response.type) {
					case 'return':
						return response.value;

					case 'continue':
						return await this.execute(thread);

					case 'void':
						return;

					default:
						throw new Error('Unknown response type');
				}
			} catch (e) {
				console.error(e);

				if (counter < this.max_retries)
					await this.execute(thread, counter + 1);
			}
		}
	}

	convertFunctionToResponseFormat(obj) {
		if (obj.type !== 'object')
			return {obj, count: 0};

		let properties_count = 0, required = [];

		for (let [key, property] of Object.entries(obj.properties || {})) {
			properties_count++;
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

	async afterExecute(thread, completion) {
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

				await this.error(thread, error.response.status + ': ' + JSON.stringify(error.response.data));
			} else if (error.message) {
				console.error(error.message);
				await this.error(thread, error.message);
			} else {
				console.error(error);
				await this.error(thread, 'Errore interno');
			}
		}
	}

	async error(thread, error) {
		const i = this.options.interfaces.find(i => i.name === thread.interface);
		if (i)
			return i.error(thread, error);
	}

	async output(thread, msg) {
		if (this.callbacks.hasOwnProperty(thread.interface + '-' + thread.id) && this.callbacks[thread.interface + '-' + thread.id].length) {
			const callback = this.callbacks[thread.interface + '-' + thread.id].shift();
			await callback(msg);
		}

		const i = this.options.interfaces.find(i => i.name === thread.interface);
		if (i)
			return i.output(thread, msg);
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

	async handleCompletion(thread, completion) {
		const model = Symposium.getModelByName(thread.state.model);

		const functions = [];
		for (let message of completion) {
			thread.addDirectMessage(message);
			await this.log('ai_message', message.content);

			for (let m of message.content) {
				switch (m.type) {
					case 'text':
						if (this.utility) {
							if (this.utility.type === 'text')
								return this.afterHandle(thread, completion, 'return', m.content);
							if (this.utility.type === 'json' && model.supports_structured_output)
								return this.afterHandle(thread, completion, 'return', JSON.parse(m.content));
						}
						await this.output(thread, m.content);
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
					return this.afterHandle(thread, completion, 'return', f.arguments);

				const response = await this.callFunction(thread, f);

				thread.addMessage('tool', [
					{
						type: 'function_response',
						content: {name: f.name, response, id: f.id || undefined},
					},
				], f.name);

				await this.log('function_response', response);
			}

			return this.afterHandle(thread, completion, 'continue');
		} else {
			await thread.storeState();
			return this.afterHandle(thread, completion, 'void');
		}
	}

	async afterHandle(thread, completion, type, value = null) {
		return {
			type,
			value,
		};
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

	async callFunction(thread, function_call) {
		const functions = await this.getFunctions(false);
		if (!functions.has(function_call.name))
			throw new Error('Unrecognized function ' + function_call.name);

		await this.log('function_call', function_call);

		try {
			return await functions.get(function_call.name).tool.callFunction(thread, function_call.name, function_call.arguments);
		} catch (error) {
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
}
