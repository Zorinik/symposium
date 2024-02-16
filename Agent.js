import Symposium from "./Symposium.js";
import Conversation from "./Conversation.js";

class Agent {
	name = 'Agent';
	descriptionForFront = '';
	options = {};
	conversations;
	functions = null;
	middlewares = new Map();
	tools = new Map();
	commands;

	constructor(options) {
		this.options = {
			memory_handler: null,
			...options,
		};

		if (this.options.memory_handler)
			this.options.memory_handler.setAgent(this);

		this.commands = new Map();

		this.commands.set('start', {
			description: '',
			show_in_help: false,
			exec: async conversation => {
				await conversation.reply('Benvenuto! Digita /help per un aiuto sui comandi, oppure procedi pure se già sai come usare.');
			}
		});

		this.commands.set('model', {
			description: 'Per impostare l\'utilizzo di GPT 3 o 4 (o vedere il modello che si sta usando)',
			show_in_help: true,
			exec: async (conversation, args) => {
				if (args) {
					const model_to_switch = Symposium.getModelByLabel(args);
					if (model_to_switch) {
						await conversation.setState({model: model_to_switch.name});
						await conversation.reply('# Da ora in poi uso ' + model_to_switch.label + '!');
					} else {
						await conversation.reply("# Versione modello non riconosciuta!\nModelli disponibili:\n" + Symposium.models.map(m => m.label).join("\n"));
					}
				} else {
					const currentModel = Symposium.getModelByName(conversation.state.model);
					await conversation.reply('# Il modello attualmente in uso è ' + currentModel.label);
				}
			},
		});

		this.commands.set('reset', {
			description: 'Reimposta la conversazione, facendo dimenticare al bot tutto ciò che viene prima',
			show_in_help: true,
			exec: async conversation => {
				await this.reset(conversation);
				await conversation.reply('# Conversazione resettata');
			}
		});

		this.commands.set('logout', {
			description: 'Reimposta i token di autenticazione',
			show_in_help: true,
			exec: async conversation => {
				await this.logout(conversation);
				await conversation.reply('# Logout effettuato');
			}
		});

		this.commands.set('help', {
			description: 'Aiuto sui comandi',
			show_in_help: true,
			exec: async conversation => {
				let help = "Comandi disponibili:\n";
				for (let command of this.commands.entries()) {
					if (!command[1].show_in_help)
						continue;
					help += '/' + command[0];
					if (command[1].description)
						help += ' -> ' + command[1].description;
					help += "\n";
				}

				await conversation.reply(help);
			}
		});

		this.conversations = new Map();
	}

	async logout(conversation) {
		conversation.auth = new Map();
	}

	async reset(conversation) {
		await conversation.flush();
		await this.resetState(conversation);
		await this.initConversation(conversation);
		await conversation.storeState();
	}

	async resetState(conversation) {
		conversation.state = await this.getDefaultState();
	}

	async getDefaultState() {
		return {
			model: 'gpt-4-turbo-preview',
		};
	}

	addTool(tool) {
		this.tools.set(tool.name, tool);
	}

	addMiddleware(middleware) {
		this.middlewares.set(middleware.name, middleware);
	}

	async initConversation(conversation) {
		await this.doInitConversation(conversation);
		await conversation.storeState();
	}

	async doInitConversation(conversation) {
	}

	async getConversation(id, reply = null) {
		let conversation = this.conversations.get(id);
		if (!conversation) {
			conversation = new Conversation(this.name + '-' + id);

			if (!(await conversation.loadState())) {
				await this.resetState(conversation);
				await this.initConversation(conversation);
			}

			this.conversations.set(id, conversation);
		}

		if (reply)
			conversation.reply = reply;

		return conversation;
	}

	async getConversationIfExists(id) {
		if (this.conversations.has(id))
			return this.conversations.get(id);

		const conversation = new Conversation(this.name + '-' + id);

		if (await conversation.loadState())
			return conversation;

		return null;
	}

	async message(conversation, text) {
		if (text.startsWith('/')) {
			const fullCommand = text.trim().split(' ');
			const command = fullCommand.shift().substring(1);
			const command_args = fullCommand.length ? fullCommand.join(' ').trim() : null;
			try {
				await this.executeCommand(conversation, command, command_args);
			} catch (e) {
				await conversation.reply(e.message || e.error || JSON.stringify(e));
			}

			return;
		}

		await this.execute(conversation, text);
	}

	async executeCommand(conversation, name, args) {
		const command = this.commands.get(name);
		if (!command)
			throw new Error('Comando non riconosciuto');

		await command.exec(conversation, args);
	}

	async execute(conversation, user_message) {
		for (let middleware of this.middlewares.values()) {
			let proceed = await middleware.before_add(conversation, user_message);
			if (!proceed)
				return;
		}

		if (user_message) {
			await this.log('user_message', user_message);
			conversation.addUserMessage(user_message);
		}

		if (this.options.memory_handler)
			conversation = await this.options.memory_handler.handle(conversation);

		for (let middleware of this.middlewares.values()) {
			let proceed = await middleware.before_exec(conversation, user_message);
			if (!proceed) {
				await conversation.storeState();
				return;
			}
		}

		const completion_payload = {};
		if (this.options.talking_function) {
			completion_payload.functions = [this.options.talking_function];
			completion_payload.function_call = {name: this.options.talking_function.name};
		}

		const completion = await this.generateCompletion(conversation, completion_payload);

		await this.handleCompletion(conversation, completion);

		const reversedMiddlewares = [...this.middlewares.values()];
		reversedMiddlewares.reverse();

		for (let middleware of reversedMiddlewares) {
			let proceed = await middleware.after_exec(conversation, user_message);
			if (!proceed)
				return;
		}
	}

	async generateCompletion(conversation, payload = {}, retry_counter = 1) {
		try {
			const completion_payload = {
				model: conversation.state.model,
				messages: conversation.getMessagesJson(),
				functions: await this.getFunctions(),
				...payload,
			};

			if (!completion_payload.functions?.length) {
				delete completion_payload.functions;
				if (completion_payload.hasOwnProperty('function_call'))
					delete completion_payload.function_call;
			}

			const openai = await Symposium.getOpenAi();
			const chatCompletion = await openai.chat.completions.create(completion_payload);

			let completion = chatCompletion.choices[0].message;
			if (completion.function_call && completion.function_call.arguments)
				completion.function_call.arguments = JSON.parse(completion.function_call.arguments);

			return completion;
		} catch (error) {
			if (error.response) {
				console.error(error.response.status);
				console.error(error.response.data);

				if (error.response.status >= 500 && retry_counter <= 5) {
					await new Promise(resolve => {
						setTimeout(resolve, 1000);
					});

					return this.generateCompletion(conversation, payload, retry_counter + 1);
				}

				await conversation.reply('# Errore ' + error.response.status + ': ' + JSON.stringify(error.response.data));
			} else if (error.message) {
				console.error(error.message);
				await conversation.reply('# Errore ' + error.message);
			} else {
				console.error(error);
				await conversation.reply('# Errore interno');
			}
		}
	}

	async handleCompletion(conversation, completion) {
		if (this.options.talking_function && completion.function_call) {
			const text = completion.function_call.arguments[Object.keys(this.options.talking_function.parameters.properties)[0]];
			conversation.addAssistantMessage(text);
			await this.log('ai_message', text);
			await conversation.reply(text);
			return conversation.storeState()
		}

		conversation.addAssistantMessage(completion.content, completion.function_call ? {
			...completion.function_call,
			arguments: JSON.stringify(completion.function_call.arguments),
		} : null);
		if (completion.content) {
			await this.log('ai_message', completion.content);
			await conversation.reply(completion.content);
		}

		if (completion?.function_call)
			return this.callFunction(conversation, completion.function_call);
		else
			return conversation.storeState();
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

	async callFunction(conversation, function_call) {
		let functions = await this.getFunctions(false);
		if (!functions.has(function_call.name))
			throw new Error('Unrecognized function ' + function_call.name);

		await this.log('function_call', function_call);

		try {
			const response = await functions.get(function_call.name).tool.callFunction(conversation, function_call.name, function_call.arguments);
			conversation.addFunctionMessage(response, function_call.name);
			await this.log('function_response', response);
		} catch (error) {
			conversation.addFunctionMessage({error}, function_call.name);
			await this.log('function_response', {error});
		}

		await this.execute(conversation);
	}

	async log(type, payload) {
		if (this.options.logger)
			return this.options.logger.log(this.name, type, payload);
	}

	async getPromptWordsForTranscription(conversation) {
		return [this.name];
	}
}

export default Agent;
