import OpenAIModel from "./OpenAIModel.js";

export default class Whisper extends OpenAIModel {
	type = 'stt';
	name = 'whisper';

	async transcribe(file, prompt = null) {
		const response = await this.getOpenAi().audio.transcriptions.create({
			model: 'gpt-4o-transcribe',
			file,
			prompt,
		});

		return response.text;
	}
}
