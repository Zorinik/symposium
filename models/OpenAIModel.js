import Model from "../Model.js";
import OpenAI from "openai";

export default class OpenAIModel extends Model {
	openai;
	vendor = 'openai';
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

		const completion = chatCompletion.choices[0].message;
		if (completion.function_call && completion.function_call.arguments)
			completion.function_call.arguments = JSON.parse(completion.function_call.arguments);

		return completion;
	}
}
