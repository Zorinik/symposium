import LegacyOpenAIModel from "./LegacyOpenAIModel.js";
import OpenAI from "openai";

export default class GrokModel extends LegacyOpenAIModel {
	async getModels() {
		return new Map([
			['grok-4', {
				name: 'grok-4',
				tokens: 256000,
				tools: true,
			}],
		]);
	}

	getOpenAi() {
		if (!this.openai) {
			this.openai = new OpenAI({
				baseURL: 'https://api.x.ai/v1',
				apiKey: process.env.GROK_API_KEY,
			});
		}

		return this.openai;
	}

	async generate(model, thread, functions = [], options = {}) {
		if (options.image_generation) {
			functions.push({
				name: 'generate_image',
				description: 'Generate an image based on a detailed prompt that you provide',
				parameters: {
					type: 'object',
					properties: {
						prompt: {
							type: 'string',
							description: 'A detailed description of the image to generate - MUST be in English',
						},
					},
					required: ['prompt'],
				},
			});
		}

		const response = await super.generate(model, thread, functions, options);

		// Check for image generation response
		if (options.image_generation) {
			const function_call = response[0].content.find(c => c.type === 'function');
			if (function_call) {
				const generation_call = function_call.content.find(f => f.name === 'generate_image');
				if (generation_call) {
					const response = await this.getOpenAi().images.generate({
						model: 'grok-2-image',
						prompt: generation_call.arguments.prompt,
					});

					function_call.type = 'image';
					function_call.content = {
						type: 'url',
						mime: 'image/jpeg',
						data: response.data[0].url,
					};
				}
			}
		}

		return response;
	}
}
