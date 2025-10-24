import OpenAIModel from "./OpenAIModel.js";

export default class OpenAITranscribe extends OpenAIModel {
	type = 'stt';

	async getModels() {
		return new Map([
			['gpt-4o-transcribe', {name: 'gpt-4o-transcribe'}],
		]);
	}

	async transcribe(file, model, prompt = null) {
		const response = await this.getOpenAi().audio.transcriptions.create({
			model: model.name,
			file,
			prompt,
		});

		return response.text;
	}
}
