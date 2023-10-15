import Redis from "@travio/redis";
import OpenAI from "openai";

class Symposium {
	static openai;
	static models = [
		{
			label: 'gpt-3.5',
			name: 'gpt-3.5-turbo-16k',
			tokens: 16384,
		},
		{
			label: 'gpt-4',
			name: 'gpt-4',
			tokens: 8192
		}
	];

	static async init() {
		return Redis.init();
	}

	static async getOpenAi() {
		if (!this.openai)
			this.openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

		return this.openai;
	}

	static getModelByLabel(label) {
		return this.models.find(model => model.label === label);
	}

	static getModelByName(name) {
		return this.models.find(model => model.name === name);
	}

	static async transcribe(agent, file, conversation) {
		let words = await agent.getPromptWordsForTranscription(conversation);

		let response = await this.openai.audio.transcriptions.create({
			file,
			model: 'whisper-1',
			prompt: words.join(', '),
		});
		return response.text;
	}
}

export {Symposium};
