import OpenAIModel from "./OpenAIModel.js";
import OpenAI from "openai";

export default class DeepSeekModel extends OpenAIModel {
	models = new Map([
		['deepseek-chat', {
			name: 'deepseek-chat',
			tokens: 64000,
		}],
		['deepseek-reasoner', {
			name: 'deepseek-reasoner',
			tokens: 64000,
		}],
	]);

	getOpenAi() {
		if (!this.openai) {
			this.openai = new OpenAI({
				baseURL: 'https://api.deepseek.com',
				apiKey: process.env.DEEPSEEK_API_KEY,
			});
		}

		return this.openai;
	}
}
