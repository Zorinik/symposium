import Response from "../Response.js";
import Model from "../Model.js";
import OpenAI from "openai";
import Message from "../Message.js";

export default class OpenAIModel extends Model {
	openai;
	supports_tools = true;

	getOpenAi() {
		if (!this.openai)
			this.openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

		return this.openai;
	}

	async generate(thread, payload = {}, functions = []) {
		const completion_payload = {
			model: this.name,
			messages: thread.getMessagesJson(),
			functions,
			...payload,
		};

		if (!completion_payload.functions?.length) {
			delete completion_payload.functions;
			if (completion_payload.hasOwnProperty('function_call'))
				delete completion_payload.function_call;
		}

		const chatCompletion = await this.getOpenAi().chat.completions.create(completion_payload);

		const response = new Response;
		const completion = chatCompletion.choices[0].message;
		if (completion.content)
			response.messages.push(new Message('assistant', completion.content));

		if (completion.function_call && completion.function_call.arguments) {
			response.function = {
				name: completion.function_call.name,
				args: JSON.parse(completion.function_call.arguments),
			};
		}

		return response;
	}
}
