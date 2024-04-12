import OpenAIModel from "./OpenAIModel.js";

export default class Gpt4Turbo extends OpenAIModel {
	name = 'gpt-4-turbo';
	label = 'gpt-4-turbo';
	name_for_tiktoken = 'gpt-4';
	tokens = 128000;
}
