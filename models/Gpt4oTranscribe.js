import OpenAIModel from "./OpenAIModel.js";

export default class Gpt4oTranscribe extends OpenAIModel {
	type = 'stt';
	name = 'gpt4o-transcribe';

	async transcribe(file, prompt = null) {
		const response = await this.getOpenAi().audio.transcriptions.create({
			model: 'gpt-4o-transcribe',
			file,
			prompt,
		});

		return response.text;
	}
}
