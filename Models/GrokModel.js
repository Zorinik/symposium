import OpenAI from "openai";
import OpenAIModel from "./OpenAIModel.js";

export default class GrokModel extends OpenAIModel {
	async getModels() {
		return new Map([
			['grok-4-1-fast-reasoning', {
				name: 'grok-4-1-fast-reasoning',
				tokens: 2000000,
				tools: true,
			}],
			['grok-4-1-fast-non-reasoning', {
				name: 'grok-4-1-fast-non-reasoning',
				tokens: 2000000,
				tools: true,
			}],
			['grok-4-20-fast-reasoning', {
				name: 'grok-4.20-beta-0309-reasoning',
				tokens: 2000000,
				tools: true,
			}],
			['grok-4-20-fast-non-reasoning', {
				name: 'grok-4.20-beta-0309-non-reasoning',
				tokens: 2000000,
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

	async generate(model, thread, tools = [], options = {}) {
		if (options.image_generation) {
			tools.push({
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

		const response = await super.generate(model, thread, tools, options);

		// Check for image generation response
		if (options.image_generation) {
			const tool_call_block = response[0].content.find(c => c.type === 'tool_call');
			if (tool_call_block) {
				const generation_call = tool_call_block.content.find(t => t.name === 'generate_image');
				if (generation_call) {
					const response = await this.getOpenAi().images.generate({
						model: 'grok-imagine-image',
						prompt: generation_call.arguments.prompt,
					});

					tool_call_block.type = 'image';
					tool_call_block.content = {
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
