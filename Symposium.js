import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

import Agent from "./Agent.js";

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
	static async init(storage = null) {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = path.dirname(__filename);
		const modelsPath = path.join(__dirname, 'models');

		const modelFiles = await fs.promises.readdir(modelsPath);
		for (const file of modelFiles) {
			if (!file.endsWith('.js'))
				continue;

			const module = await import(`./Models/${file}`);
			const ModelClass = module.default;
			if (ModelClass)
				this.loadModel(new ModelClass());
		}

		if (storage) {
			this.storage = storage;
			await this.storage.init();
		}
	}

	static loadModel(model_class) {
		for (let [key, model] of model_class.models.entries()) {
			if (this.models.has(key))
				throw new Error(`Duplicate model with key "${key}"`);

			this.models.set(key, {
				...model,
				type: model_class.type,
				class: model_class,
			});
		}
	}

	static getModel(name) {
		return this.models.get(name);
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

	static async transcribe(audio, prompt = null, model = null) {
		model = model || process.env.TRANSCRIPTION_MODEL;
		if (!model)
			throw new Error('Transcription model not specified');

		if (!this.transcription_model)
			this.transcription_model = Symposium.getModel(model);
		if (!this.transcription_model.type !== 'stt')
			throw new Error('Specified model is not a transcription model');

		let file;
		switch (audio.type) {
			case 'url':
				if (!audio.data)
					throw new Error('Audio URL is required');

				if (path.isAbsolute(audio.data)) { // Local path
					// Get with fs
					if (!fs.existsSync(audio.data))
						throw new Error('Audio file does not exist at the specified path: ' + audio.data);

					file = fs.readFileSync(audio.data);
				} else {
					file = await fetch(audio.data).then(res => res.blob());
				}

				file = new File([file], 'audio.' + this.getExtFromMime(file.type), {type: file.type});
				break;

			case 'base64':
				file = new File([Buffer.from(audio.data, 'base64')], 'audio.' + this.getExtFromMime(audio.mime), {type: audio.mime});
				break;
		}

		return this.transcription_model.transcribe(file, model, prompt);
	}

	static getExtFromMime(mime) {
		const mimeToExt = {
			'audio/mpeg': 'mp3',
			'audio/wav': 'wav',
			'audio/ogg': 'ogg',
			'audio/flac': 'flac',
			'audio/aac': 'aac',
			'audio/mp4': 'm4a',
			'audio/webm': 'webm',
		};

		return mimeToExt[mime] || null;
	}

	static async prompt(system, prompt, options = {}) {
		const agent = new Agent(options.agent || {});
		agent.type = 'utility';
		agent.utility = options.response || {
			type: 'text',
		};

		agent.doInitThread = async thread => {
			if (options.model)
				await thread.setModel(options.model);
			await thread.addMessage('system', system);
		};

		const thread = await agent.getThread();
		return agent.message(prompt, thread);
	}
}
