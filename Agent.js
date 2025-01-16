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

	async getThread(id, i) {
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

	async message(thread, i, content) {
		if (typeof thread !== 'object')
			thread = await this.getThread(thread, i);

		await this.log('user_message', content);
		thread.addMessage('user', content);

		await this.execute(thread);

		return thread;
	}

	async beforeExecute(thread) {
		if (this.options.memory_handler)
			thread = await this.options.memory_handler.handle(thread);
		return thread;
	}

	async execute(thread, counter = 0) {
		if (counter === 0)
			thread = await this.beforeExecute(thread);

		const completion = await this.generateCompletion(thread);
		if (completion) {
			try {
				thread = await this.afterExecute(thread, completion);
				const interrupt = await this.handleCompletion(thread, completion);
				if (!interrupt)
					await this.execute(thread);
			} catch (e) {
				console.error(e);

				if (counter < this.max_retries)
					await this.execute(thread, counter + 1);
			}
		}
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
		const functions = [];
		for (let message of completion) {
			thread.addDirectMessage(message);
			await this.log('ai_message', message.content);

			for (let m of message.content) {
				switch (m.type) {
					case 'text':
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
				const response = await this.callFunction(thread, f);

				thread.addMessage('tool', [
					{
						type: 'function_response',
						content: {name: f.name, response, id: f.id || undefined},
					},
				], f.name);

				await this.log('function_response', response);
			}

			return this.afterHandle(thread, completion, true);
		} else {
			await thread.storeState();
			return this.afterHandle(thread, completion, false);
		}
	}

	async afterHandle(thread, completion, executed_function) {
		return !executed_function;
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
