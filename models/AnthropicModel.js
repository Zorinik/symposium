import Model from "../Model.js";
import Anthropic from '@anthropic-ai/sdk';
import Message from "../Message.js";

export default class AnthropicModel extends Model {
	anthropic;
	supports_functions = false;

	getAnthropic() {
		if (!this.anthropic)
			this.anthropic = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});

		return this.anthropic;
	}

	async generate(thread, payload = {}, functions = []) {
		let [system, messages] = this.convertMessages(thread);

		if (functions.length && !this.supports_functions) {
			// Se il modello non supporta nativamente le funzioni, aggiungo il prompt al messaggio di sistema
			const functions_prompt = this.promptFromFunctions(payload, functions);
			system += "\n\n" + functions_prompt;
			functions = [];
		}

		const completion_payload = {
			model: this.name,
			system,
			max_tokens: 4096,
			messages,
			...payload,
		};

		const message = await this.getAnthropic().messages.create(completion_payload);

		const message_content = [];
		if (message.content) {
			for (let m of message.content) {
				switch (m.type) {
					case 'text':
						message_content.push({type: 'text', content: m.text});
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
		let system = [], messages = [];
		for (let message of thread.messages) {
			if (message.role === 'system') {
				system.push(message.content.map(c => c.content).join("\n"));
			} else {
				messages.push({
					role: message.role === 'function' ? 'user' : message.role,
					content: message.content.map(c => {
						switch (c.type) {
							case 'text':
								return {
									type: 'text',
									text: (message.role === 'function' ? 'FUNCTION RESPONSE: ' : '') + c.content,
								};

							case 'function':
								return {
									type: 'text',
									text: '```CALL \n' + c.content.name + '\n' + JSON.stringify(c.content.arguments || {}) + '\n```',
								};

							default:
								throw new Error('Message type "' + c.type + '" unsupported by this model');
						}
					}),
				});
			}
		}

		return [system.length ? system.join("\n") : undefined, messages];
	}
}
