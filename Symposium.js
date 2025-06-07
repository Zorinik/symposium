import Gpt35 from "./models/Gpt35.js";
import Gpt4 from "./models/Gpt4.js";
import Gpt4Turbo from "./models/Gpt4Turbo.js";
import Gpt4O from "./models/Gpt4O.js";
import GptO1 from "./models/GptO1.js";
import GptO1Mini from "./models/GptO1Mini.js";
import Whisper from "./models/Whisper.js";
import Claude35Sonnet from "./models/Claude35Sonnet.js";
import Claude37Sonnet from "./models/Claude37Sonnet.js";
import Claude4Sonnet from "./models/Claude4Sonnet.js";
import Claude4Opus from "./models/Claude4Opus.js";
import Llama3 from "./models/Llama3.js";
import Mixtral8 from "./models/Mixtral8.js";
import DeepSeekChat from "./models/DeepSeekChat.js";
import DeepSeekReasoner from "./models/DeepSeekReasoner.js";

export default class Symposium {
	static models = new Map();
	static storage = null;
	static transcription_model = null;

	/*
	* Storage must expose the following methods:
	* - async init()
	* - async get(key)
	* - async set(key, value)
	 */
	static async init(storage) {
		this.loadModel(new Gpt35());
		this.loadModel(new Gpt4());
		this.loadModel(new Gpt4Turbo());
		this.loadModel(new Gpt4O());
		this.loadModel(new GptO1());
		this.loadModel(new GptO1Mini());
		this.loadModel(new Whisper());

		this.loadModel(new Claude35Sonnet());
		this.loadModel(new Claude37Sonnet());
		this.loadModel(new Claude4Sonnet());
		this.loadModel(new Claude4Opus());

		this.loadModel(new Llama3());
		this.loadModel(new Mixtral8());

		this.loadModel(new DeepSeekChat());
		this.loadModel(new DeepSeekReasoner());

		this.storage = storage;
		await this.storage.init();
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

	static async transcribe(audio, prompt = null) {
		if (!process.env.TRANSCRIPTION_MODEL)
			throw new Error('Transcription is not enabled');
		if (audio.type !== 'base64')
			throw new Error('Audio content must be base64 encoded');

		if (!this.transcription_model)
			this.transcription_model = Symposium.getModelByName(process.env.TRANSCRIPTION_MODEL);

		const ext = audio.type === 'audio/mpeg' ? 'mp3' : 'wav';
		return this.transcription_model.transcribe(new File([Buffer.from(audio.data, 'base64')], 'audio.' + ext, {type: audio.type}), prompt);
	}
}
