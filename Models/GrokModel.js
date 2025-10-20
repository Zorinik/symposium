import OpenAIModel from "./OpenAIModel.js";
import OpenAI from "openai";

export default class GrokModel extends OpenAIModel {
	models = new Map([
		['grok-4', {
			name: 'grok-4',
			tokens: 256000,
		}],
	]);

	getOpenAi() {
		if (!this.openai) {
			this.openai = new OpenAI({
				baseURL: 'https://api.x.ai/v1',
				apiKey: process.env.GROK_API_KEY,
			});
		}

		return this.openai;
	}
}
