import ollama from "ollama";
import Model from "../Model.js";
import Message from "../Message.js";

export default class OllamaModel extends Model {
	getOllama() {
		return ollama;
	}

	async getModels() {
		try {
			const {models} = await this.getOllama().list();

			const map = new Map();

			for (let m of models) {
				map.set(m.name, {
					name: m.name,
					tokens: null, // TODO
					tools: true,
					structured_output: true,
				})
			}

			return map;
		} catch (e) {
			// Ollama daemon not running or not reachable
			return new Map();
		}
	}

	async *generate(model, thread, functions = [], options = {}) {
		const parsed = this.parseOptions(options, functions);
		options = parsed.options;
		functions = parsed.functions;

		let messages = thread.messages;

		if (functions.length && !model.tools) {
			// Se il modello non supporta nativamente le funzioni, inserisco il prompt ad hoc come ultimo messaggio di sistema
			const functions_prompt = this.promptFromFunctions(options, functions);
			let system_messages = [], other_messages = [], first_found = false;
			for (let message of messages) {
				if (!first_found && message.role !== 'system')
					first_found = true;

				if (!first_found)
					system_messages.push(message);
				else
					other_messages.push(message);
			}

			system_messages.push(new Message('system', functions_prompt));

			messages = [...system_messages, ...other_messages];
			functions = [];
		}

		const convertedMessages = [];
		for (let m of messages)
			convertedMessages.push(...this.convertMessage(m, model));

		const completion_payload = {
			model: model.name,
			messages: convertedMessages,
			tools: functions.map(f => ({
				type: 'function',
				function: f,
			})),
			stream: true,
		};

		if (options.force_function) {
			completion_payload.tool_choice = {
				type: 'function',
				function: {name: options.force_function},
			};
		}

		if (options.response_format) {
			if (!options.response_format.json_schema)
				throw new Error('OllamaModel only supports response_format with json_schema');
			completion_payload.format = options.response_format.json_schema.schema;
		}

		if (!completion_payload.tools.length)
			delete completion_payload.tools;

		const stream = await this.getOllama().chat(completion_payload);

		let fullText = '';
		let fullThinking = '';
		const toolCalls = [];

		for await (const chunk of stream) {
			const m = chunk.message;
			if (!m)
				continue;

			if (m.thinking) {
				fullThinking += m.thinking;
				yield {type: 'reasoning_delta', content: m.thinking};
			}

			if (m.content) {
				fullText += m.content;
				yield {type: 'text_delta', content: m.content};
			}

			if (m.tool_calls?.length) {
				for (const tool_call of m.tool_calls) {
					if (!tool_call.function)
						throw new Error('Unsupported tool type');

					const tc = {
						name: tool_call.function.name,
						arguments: tool_call.function.arguments || {},
					};
					toolCalls.push(tc);
					yield {type: 'tool_call', content: tc};
				}
			}
		}

		const message_content = [];
		if (fullThinking)
			message_content.push({type: 'reasoning', content: fullThinking});

		if (fullText)
			message_content.push({type: 'text', content: fullText});

		if (toolCalls.length)
			message_content.push({type: 'function', content: toolCalls});

		return [
			new Message('assistant', message_content),
		];
	}

	convertMessage(message, model) {
		const messages = [],
			role = message.role === 'system' ? this.system_role_name : message.role;

		let reasoning = null;
		for (let c of message.content) {
			switch (c.type) {
				case 'reasoning':
					reasoning = c.content;
					break;

				case 'text':
					messages.push({
						role,
						content: c.content,
						thinking: reasoning || undefined,
					});
					break;

				case 'function':
					if (model.tools) {
						messages.push({
							role,
							thinking: reasoning || undefined,
							tool_calls: c.content.map(tool_call => ({
								id: tool_call.id,
								type: 'function',
								function: {
									name: tool_call.name,
									arguments: tool_call.arguments || {},
								},
							})),
						});
					} else {
						messages.push({
							role,
							thinking: reasoning || undefined,
							content: c.content.map(f => '```CALL \n' + f.name + '\n' + JSON.stringify(f.arguments || {}) + '\n```').join("\n\n"),
						});
					}
					break;

				case 'function_response':
					if (model.tools) {
						messages.push({
							role: 'tool',
							content: JSON.stringify(c.content.response),
							tool_name: message.name,
						});
					} else {
						messages.push({
							role: 'user',
							content: 'FUNCTION RESPONSE:\n' + JSON.stringify(c.content.response),
						});
					}
					break;

				default:
					throw new Error('Message type unsupported by this model');
			}
		}

		return messages;
	}
}
