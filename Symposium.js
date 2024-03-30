import Redis from "@travio/redis";
import Gpt35 from "./models/Gpt35.js";
import Gpt4 from "./models/Gpt4.js";
import Gpt4Turbo from "./models/Gpt4Turbo.js";
import Gpt4Vision from "./models/Gpt4Vision.js";
import Whisper from "./models/Whisper.js";
import Claude3Haiku from "./models/Claude3Haiku.js";
import Claude3Sonnet from "./models/Claude3Sonnet.js";
import Claude3Opus from "./models/Claude3Opus.js";

export default class Symposium {
	static models = new Map();

	static async init() {
		this.loadModel(new Gpt35());
		this.loadModel(new Gpt4());
		this.loadModel(new Gpt4Turbo());
		this.loadModel(new Gpt4Vision());
		this.loadModel(new Whisper());

		this.loadModel(new Claude3Haiku());
		this.loadModel(new Claude3Sonnet());
		this.loadModel(new Claude3Opus());

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
}
