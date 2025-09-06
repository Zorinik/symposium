import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

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

			const module = await import(`./models/${file}`);
			const ModelClass = module.default;
			if (ModelClass) {
				const model = new ModelClass();
				if (!model.name)
					continue;
				this.loadModel(model);
			}
		}

		if (storage) {
			this.storage = storage;
			await this.storage.init();
		}
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

		if (!this.transcription_model)
			this.transcription_model = Symposium.getModelByName(process.env.TRANSCRIPTION_MODEL);

		return this.transcription_model.transcribe(file, prompt);
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
}
