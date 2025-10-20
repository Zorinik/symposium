import OpenAIModel from "./OpenAIModel.js";

export default class OpenAIEmbedding extends OpenAIModel {
	type = 'embedding';
	models = new Map([
		['openai-text-embedding-3-large', {name: 'text-embedding-3-large'}],
		['openai-text-embedding-3-small', {name: 'text-embedding-3-small'}],
	]);

	async embed(input, model) {
		const response = await this.getOpenAi().embeddings.create({
			model: model.name,
			input,
		});

		return response.data[0].embedding;
	}
}
