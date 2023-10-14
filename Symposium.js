import Redis from "@travio/redis";
import OpenAI from "openai";

class Symposium {
	static openai;

	static async init() {
		return Redis.init();
	}

	static async getOpenAi() {
		if (!this.openai)
			this.openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

		return this.openai;
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
