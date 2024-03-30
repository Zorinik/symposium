import Response from "../Response.js";
import Model from "../Model.js";
import OpenAI from "openai";
import Message from "../Message.js";

export default class OpenAIModel extends Model {
	openai;
	supports_functions = true;

	getOpenAi() {
		if (!this.openai)
			this.openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

		return this.openai;
	}

	async generate(thread, payload = {}, functions = []) {
		let messages = thread.getMessagesJson();

		if (functions.length && !this.supports_functions) {
			// Se il modello non supporta nativamente le funzioni, inserisco il prompt ad hoc come ultimo messaggio di sistema
			const functions_prompt = this.promptFromFunctions(functions);
			let system_messages = [], other_messages = [], first_found = false;
			for (let message of messages) {
				if (!first_found && message.role !== 'system')
					first_found = true;

				if (!first_found)
					system_messages.push(message);
				else
					other_messages.push(message);
			}

			system_messages.push({role: 'system', content: functions_prompt});

			messages = [...system_messages, ...other_messages];
			functions = [];
		}

		const completion_payload = {
			model: this.name,
			messages,
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
