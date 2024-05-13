import OpenAIModel from "./OpenAIModel.js";

export default class Gpt4O extends OpenAIModel {
	name = 'gpt-4o';
	label = 'gpt-4o';
	name_for_tiktoken = 'gpt-4';
	tokens = 128000;
}
