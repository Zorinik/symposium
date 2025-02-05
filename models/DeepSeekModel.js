import OpenAIModel from "./OpenAIModel.js";
import OpenAI from "openai";

export default class DeepSeekModel extends OpenAIModel {
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
