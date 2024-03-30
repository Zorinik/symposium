import Redis from "@travio/redis";
import OpenAI from "openai";
import Gpt35 from "./models/Gpt35.js";
import Gpt4 from "./models/Gpt4.js";
import Gpt4Turbo from "./models/Gpt4Turbo.js";
import Gpt4Vision from "./models/Gpt4Vision.js";

export default class Symposium {
	static models = new Map();

	static async init() {
		this.loadModel(new Gpt35());
		this.loadModel(new Gpt4());
		this.loadModel(new Gpt4Turbo());
		this.loadModel(new Gpt4Vision());

		return Redis.init();
	}

	static loadModel(model) {
		this.models.set(model.name, model);
	}

	static getModelByName(name) {
		return this.models.get(name);
	}

	static getModelByLabel(label) {
		return Array.from(this.models.values()).find(model => model.label === label);
	}

	/*static async transcribe(agent, file, thread) {
		const words = await agent.getPromptWordsForTranscription(thread);

		const response = await this.getOpenAi().then(openai => openai.audio.transcriptions.create({
			file,
			model: 'whisper-1',
			prompt: words.join(', '),
		}));
		return response.text;
	}*/
}
