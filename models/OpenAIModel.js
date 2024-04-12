import Model from "../Model.js";
import OpenAI from "openai";
import Message from "../Message.js";
import {encoding_for_model} from "tiktoken";

export default class OpenAIModel extends Model {
	openai;
	name_for_tiktoken;
	supports_functions = true;

	getOpenAi() {
		if (!this.openai)
			this.openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

		return this.openai;
	}

	async generate(thread, functions = [], options = {}) {
		const parsed = this.parseOptions(options, functions);
		options = parsed.options;
		functions = parsed.functions;

		let messages = thread.messages;

		if (functions.length && !this.supports_functions) {
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
			convertedMessages.push(...this.convertMessage(m));

		const completion_payload = {
			model: this.name,
			messages: convertedMessages,
			tools: functions.map(f => ({
				type: 'function',
				function: f,
			})),
		};

		if (options.force_function) {
			completion_payload.tool_choice = {
				type: 'function',
				function: {name: options.force_function},
			};
		}

		if (!completion_payload.tools.length)
			delete completion_payload.tools;

		const chatCompletion = await this.getOpenAi().chat.completions.create(completion_payload);
		const completion = chatCompletion.choices[0].message;

		const message_content = [];
		if (completion.content)
			message_content.push({type: 'text', content: completion.content});

		if (completion.tool_calls?.length) {
			message_content.push({
				type: 'function',
				content: completion.tool_calls.map(tool_call => {
					if (tool_call.type !== 'function')
						throw new Error('Unsupported tool type ' + tool_call.type);

					return {
						id: tool_call.id,
						name: tool_call.function.name,
						arguments: tool_call.function.arguments ? JSON.parse(tool_call.function.arguments) : {},
					};
				}),
			});
		}

		return [
			new Message('assistant', message_content),
		];
	}

	async countTokens(thread) {
		try {
			const encoder = encoding_for_model(this.name_for_tiktoken || this.name);

			const texts = [];
			for (let message of thread.messages)
				texts.push(message.content.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(''));
			return encoder.encode(texts.join('')).length;
		} catch (e) {
			throw new Error('Error while counting tokens');
		}
	}

	convertMessage(message) {
		const messages = [];
		for (let c of message.content) {
			switch (c.type) {
				case 'text':
					messages.push({
						role: message.role,
						content: c.content,
						name: message.name,
					});
					break;

				case 'function':
					if (this.supports_functions) {
						messages.push({
							role: message.role,
							name: message.name,
							tool_calls: c.content.map(tool_call => ({
								id: tool_call.id,
								type: 'function',
								function: {
									name: tool_call.name,
									arguments: tool_call.arguments ? JSON.stringify(tool_call.arguments) : '{}',
								},
							})),
						});
					} else {
						messages.push({
							role: message.role,
							content: c.content.map(f => '```CALL \n' + f.name + '\n' + JSON.stringify(f.arguments || {}) + '\n```').join("\n\n"),
							name: message.name,
						});
					}
					break;

				case 'function_response':
					if (this.supports_functions) {
						messages.push({
							role: message.role,
							tool_call_id: c.content.id,
							content: JSON.stringify(c.content.response),
							name: message.name,
						});
					} else {
						messages.push({
							role: 'user',
							content: 'FUNCTION RESPONSE:\n' + JSON.stringify(c.content.response),
							name: message.name,
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
