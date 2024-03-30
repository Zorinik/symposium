import OpenAIModel from "./OpenAIModel.js";

export default class Whisper extends OpenAIModel {
	type = 'stt';
	name = 'whisper';

	async transcribe(agent, thread, file) {
		const words = await agent.getPromptWordsForTranscription(thread);

		const response = await this.getOpenAi().audio.transcriptions.create({
			file,
			model: 'whisper-1',
			prompt: words.join(', '),
		});
		return response.text;
	}
}
