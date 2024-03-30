import Model from "../Model.js";
import Anthropic from '@anthropic-ai/sdk';
import Response from "../Response.js";
import Message from "../Message.js";

export default class AnthropicModel extends Model {
	anthropic;
	supports_tools = false;

	getAnthropic() {
		if (!this.anthropic)
			this.anthropic = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});

		return this.anthropic;
	}

	async generate(thread, payload = {}, functions = []) {
		const [system, messages] = this.convertMessages(thread);

		const completion_payload = {
			model: this.name,
			system,
			max_tokens: 4096,
			messages,
			...payload,
		};

		const message = await this.getAnthropic().messages.create(completion_payload);

		const response = new Response;
		if (message.content) {
			for (let m of message.content)
				// TODO: supporto ad altri tipi oltre a text (m.type)
				response.messages.push(new Message('assistant', m.text));
		}

		return response;
	}

	convertMessages(thread) {
		let system = [], messages = [];
		for (let message of thread.getMessagesJson()) {
			if (message.role === 'system')
				system.push(message.content);
			else
				messages.push(message);
		}

		return [system.length ? system.join("\n") : undefined, messages];
	}
}
