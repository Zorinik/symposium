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

		let [system, messages] = await this.convertMessages(thread);

		if (functions.length && !this.supports_functions) {
			// Se il modello non supporta nativamente le funzioni, aggiungo il prompt al messaggio di sistema
			const functions_prompt = this.promptFromFunctions(options, functions);
			system += "\n\n" + functions_prompt;
			functions = [];
		}

		const completion_payload = {
			model: this.name,
			system,
			max_tokens: 16000,
			thinking: {
				type: "enabled",
				budget_tokens: 10000,
			},
			betas: ["interleaved-thinking-2025-05-14"],
			messages,
			tools: functions.map(f => ({
				name: f.name,
				description: f.description,
				input_schema: f.parameters,
				required: f.required || undefined,
			})),
		};

		if (options.force_function) {
			completion_payload.tool_choice = {
				type: 'tool',
				name: options.force_function,
			};
		}

		const message = await this.getAnthropic().beta.messages.create(completion_payload);

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
							content: [
								{
									id: m.id,
									name: m.name,
									arguments: m.input,
								},
							],
						});
						break;

					case 'thinking':
						message_content.push({
							type: 'reasoning',
							content: m.thinking,
							original: m,
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

	async convertMessages(thread) {
		let system = [], messages = [], lastMessage = null;
		for (let message of thread.messages) {
			if (message.role === 'system') {
				system.push(message.content.map(c => c.content).join("\n"));
			} else {
				const content = [];
				for (let c of message.content) {
					switch (c.type) {
						case 'text':
							content.push({
								type: 'text',
								text: c.content.trim(),
							});
							break;

						case 'function':
							content.push({
								type: 'tool_use',
								name: c.content[0].name,
								input: c.content[0].arguments,
								id: c.content[0].id,
							});
							break;

						case 'function_response':
							content.push({
								type: 'tool_result',
								content: JSON.stringify(c.content.response),
								tool_use_id: c.content.id,
							});
							break;

						case 'image':
							switch (c.content.type) {
								case 'base64':
									content.push({
										type: 'image',
										source: {
											type: 'base64',
											media_type: c.content.mime,
											data: c.content.data,
										},
									});
									break;

								case 'url':
									console.log('Retrieving the image...');
									const image = await fetch(c.content.data).then(r => (r?.ok ? r.arrayBuffer() : null));
									if (!image)
										throw new Error('Error while downloading the image');

									content.push({
										type: 'image',
										source: {
											type: 'base64',
											media_type: c.content.mime,
											data: Buffer.from(image).toString('base64'),
										},
									});
									break;

								default:
									throw new Error('Image source not supported');
							}
							break;

						case 'audio':
							if (c.content.transcription) {
								content.push({
									type: 'text',
									text: '[transcribed] ' + c.content.transcription,
								});
							} else {
								throw new Error('Audio content is not supported by this model');
							}
							break;

						case 'reasoning':
							content.push(c.original);
							break;

						default:
							throw new Error('Message type "' + c.type + '" unsupported by this model');
					}
				}

				const parsedMessage = {
					role: ['function', 'tool'].includes(message.role) ? 'user' : (message.role === 'system' ? this.system_role_name : message.role),
					content,
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
