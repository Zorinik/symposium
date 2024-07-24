import Redis from "@travio/redis";
import Gpt35 from "./models/Gpt35.js";
import Gpt4 from "./models/Gpt4.js";
import Gpt4Turbo from "./models/Gpt4Turbo.js";
import Gpt4O from "./models/Gpt4O.js";
import Whisper from "./models/Whisper.js";
import Claude3Haiku from "./models/Claude3Haiku.js";
import Claude3Sonnet from "./models/Claude3Sonnet.js";
import Claude3Opus from "./models/Claude3Opus.js";
import Claude35Sonnet from "./models/Claude35Sonnet.js";
import Llama3Reasoning from "./models/Llama3Reasoning.js";
import Llama3Versatile from "./models/Llama3Versatile.js";
import Mixtral8 from "./models/Mixtral8.js";

export default class Symposium {
	static models = new Map();

	static async init() {
		this.loadModel(new Gpt35());
		this.loadModel(new Gpt4());
		this.loadModel(new Gpt4Turbo());
		this.loadModel(new Gpt4O());
		this.loadModel(new Whisper());

		this.loadModel(new Claude3Haiku());
		this.loadModel(new Claude3Sonnet());
		this.loadModel(new Claude3Opus());

		this.loadModel(new Claude35Sonnet());

		this.loadModel(new Llama3Reasoning());
		this.loadModel(new Llama3Versatile());
		this.loadModel(new Mixtral8());

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

	static extractFunctionsFromResponse(messages) {
		const functions = [];
		for (let message of messages) {
			const functionResponse = message.content.filter(c => c.type === 'function');
			if (functionResponse.length) {
				for (let f of functionResponse) {
					for (let r of f.content)
						functions.push(r.arguments);
				}
			}
		}

		return functions;
	}
}
