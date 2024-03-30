import Symposium from "./Symposium.js";
import Thread from "./Thread.js";

export default class Agent {
	name = 'Agent';
	descriptionForFront = '';
	options = {};
	threads;
	functions = null;
	middlewares = new Map();
	tools = new Map();
	default_model = 'gpt-4-turbo';

	constructor(options) {
		this.options = {
			memory_handler: null,
			...options,
		};

		if (this.options.memory_handler)
			this.options.memory_handler.setAgent(this);

		this.threads = new Map();
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

	addMiddleware(middleware) {
		this.middlewares.set(middleware.name, middleware);
	}

	async initThread(thread) {
		await this.doInitThread(thread);
		await thread.storeState();
	}

	async doInitThread(thread) {
	}

	async getThread(id, reply = null) {
		let thread = this.threads.get(id);
		if (!thread) {
			thread = new Thread(this.name + '-' + id, this);

			if (!(await thread.loadState())) {
				await this.resetState(thread);
				await this.initThread(thread);
			}

			this.threads.set(id, thread);
		}

		if (reply)
			thread.reply = reply;

		return thread;
	}

	async getThreadIfExists(id) {
		if (this.threads.has(id))
			return this.threads.get(id);

		const thread = new Thread(this.name + '-' + id, this);

		if (await thread.loadState())
			return thread;

		return null;
	}

	async message(thread, text) {
		await this.log('user_message', text);
		thread.addUserMessage(text);

		await this.execute(thread, text);
	}

	async execute(thread) {
		if (this.options.memory_handler)
			thread = await this.options.memory_handler.handle(thread);

		for (let middleware of this.middlewares.values()) {
			let proceed = await middleware.before_exec(thread);
			if (!proceed) {
				await thread.storeState();
				return;
			}
		}

		const completion = await this.generateCompletion(thread);

		if (completion)
			await this.handleCompletion(thread, completion);

		const reversedMiddlewares = [...this.middlewares.values()];
		reversedMiddlewares.reverse();

		for (let middleware of reversedMiddlewares) {
			let proceed = await middleware.after_exec(thread);
			if (!proceed)
				return;
		}
	}

	async generateCompletion(thread, payload = {}, retry_counter = 1) {
		try {
			const model = Symposium.getModelByName(thread.state.model);
			return model.generate(thread, payload, await this.getFunctions());
		} catch (error) {
			if (error.response) {
				console.error(error.response.status);
				console.error(error.response.data);

				if (error.response.status >= 500 && retry_counter <= 5) {
					await new Promise(resolve => {
						setTimeout(resolve, 1000);
					});

					return this.generateCompletion(thread, payload, retry_counter + 1);
				}

				await thread.reply('# Errore ' + error.response.status + ': ' + JSON.stringify(error.response.data));
			} else if (error.message) {
				console.error(error.message);
				await thread.reply('# Errore ' + error.message);
			} else {
				console.error(error);
				await thread.reply('# Errore interno');
			}
		}
	}

	async handleCompletion(thread, completion) {
		for (let message of completion.messages) {
			thread.addMessage(message);
			await this.log('ai_message', message.text);
			await thread.reply(message.text);
		}

		if (completion.function) {
			thread.addAssistantMessage('', {
				name: completion.function.name,
				arguments: JSON.stringify(completion.function_call.args),
			});
		}

		if (completion.function)
			return this.callFunction(thread, completion.function);
		else
			return thread.storeState();
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
		let functions = await this.getFunctions(false);
		if (!functions.has(function_call.name))
			throw new Error('Unrecognized function ' + function_call.name);

		await this.log('function_call', function_call);

		try {
			const response = await functions.get(function_call.name).tool.callFunction(thread, function_call.name, function_call.args);
			thread.addFunctionMessage(response, function_call.name);
			await this.log('function_response', response);
		} catch (error) {
			thread.addFunctionMessage({error}, function_call.name);
			await this.log('function_response', {error});
		}

		await this.execute(thread);
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
