import OpenAIModel from "./OpenAIModel.js";
import OpenAI from "openai";

export default class GrokModel extends OpenAIModel {
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
