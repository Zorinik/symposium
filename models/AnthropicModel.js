import Model from "../Model.js";
import Anthropic from '@anthropic-ai/sdk';
import Message from "../Message.js";

export default class AnthropicModel extends Model {
	anthropic;
	supports_functions = true;

	getAnthropic() {
		if (!this.anthropic)
			this.anthropic = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});

		return this.anthropic;
	}

	async generate(thread, functions = [], options = {}) {
		const parsed = this.parseOptions(options, functions);
		options = parsed.options;
		functions = parsed.functions;

		let [system, messages] = this.convertMessages(thread);

		if (functions.length && !this.supports_functions) {
			// Se il modello non supporta nativamente le funzioni, aggiungo il prompt al messaggio di sistema
			const functions_prompt = this.promptFromFunctions(options, functions);
			system += "\n\n" + functions_prompt;
			functions = [];
		}

		const completion_payload = {
			model: this.name,
			system,
			max_tokens: 4096,
			messages,
			tools: functions.map(f => ({
				name: f.name,
				description: f.description,
				input_schema: f.parameters,
				required: f.required || undefined,
			})),
		};

		if (options.force_function) {
			completion_payload.messages[completion_payload.messages.length - 1].content.push({
				type: 'text',
				text: 'Usa il tool "' + options.force_function + '" nella tua prossima risposta!',
			});
		}

		const message = completion_payload.tools.length ?
			await this.getAnthropic().beta.tools.messages.create(completion_payload)
			: await this.getAnthropic().messages.create(completion_payload);

		const message_content = [];
		if (message.content) {
			for (let m of message.content) {
				switch (m.type) {
					case 'text':
						message_content.push({type: 'text', content: m.text});
						break;

					case 'tool_use':
						message_content.push({
							type: 'function',
							content: {
								id: m.id,
								name: m.name,
								arguments: m.input,
							},
						});
						break;

					default:
						throw new Error('Unrecognized message type in Anthropic response');
				}
			}
		}

		return [
			new Message('assistant', message_content),
		];
	}

	convertMessages(thread) {
		let system = [], messages = [], lastMessage = null;
		for (let message of thread.messages) {
			if (message.role === 'system') {
				system.push(message.content.map(c => c.content).join("\n"));
			} else {
				const parsedMessage = {
					role: message.role === 'function' ? 'user' : message.role,
					content: message.content.map(c => {
						switch (c.type) {
							case 'text':
								return {
									type: 'text',
									text: c.content.trim(),
								};

							case 'function':
								return {
									type: 'tool_use',
									name: c.content.name,
									input: c.content.arguments,
									id: c.content.id,
								};

							case 'function_response':
								return {
									type: 'tool_result',
									content: JSON.stringify(c.content.response),
									tool_use_id: c.content.id,
								};

							case 'image':
								switch (c.content.type) {
									case 'base64':
										return {
											type: 'image',
											source: {
												type: 'base64',
												media_type: c.content.mime,
												data: c.content.data,
											},
										};

									// TODO: url

									default:
										throw new Error('Image source not supported');
								}

							default:
								throw new Error('Message type "' + c.type + '" unsupported by this model');
						}
					}),
				};

				if (lastMessage && lastMessage.role === parsedMessage.role) {
					lastMessage.content = lastMessage.content.concat(message.content);
				} else {
					messages.push(parsedMessage);
					lastMessage = parsedMessage;
				}
			}
		}

		return [system.length ? system.join("\n") : undefined, messages];
	}
}
