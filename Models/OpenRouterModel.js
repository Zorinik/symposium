import LegacyOpenAIModel from "./LegacyOpenAIModel.js";
import OpenAI from "openai";

export default class OpenRouterModel extends LegacyOpenAIModel {
	async getModels() {
		return new Map([
			['qwen-3.8', {
				name: 'qwen/qwen3.8-27b',
				tokens: 1000000,
				tools: true,
			}],
			['deepseek-4-flash', {
				name: 'deepseek/deepseek-v4-flash-0731',
				tokens: 1000000,
				tools: true,
			}],
			['deepseek-4-pro', {
				name: 'deepseek/deepseek-v4-pro-0813',
				tokens: 1000000,
				tools: true,
			}],
		]);
	}

	getOpenAi() {
		if (!this.openai) {
			this.openai = new OpenAI({
				baseURL: 'https://openrouter.ai/api/v1',
				apiKey: process.env.OPENROUTER_API_KEY,
			});
		}

		return this.openai;
	}
}
