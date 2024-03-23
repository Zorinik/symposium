import Redis from "@travio/redis";
import OpenAI from "openai";
import Model from "./Model.js";

export default class Symposium {
	static openai;
	static models = [];

	static async init() {
		this.loadModel(new Model('gpt-3.5-turbo-0125', 'gpt-3.5', 16384));
		this.loadModel(new Model('gpt-4', 'gpt-4', 8192));
		this.loadModel(new Model('gpt-4-turbo-preview', 'gpt-4-turbo', 128000, 'gpt-4'));
		this.loadModel(new Model('gpt-4-vision-preview', 'gpt-4-vision', 128000, 'gpt-4'));

		return Redis.init();
	}

	static loadModel(model) {
		this.models.push(model);
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
