import OpenAIModel from "./OpenAIModel.js";

export default class Gpt4Vision extends OpenAIModel {
	name = 'gpt-4-vision-preview';
	label = 'gpt-4-vision';
	name_for_tiktoken = 'gpt-4';
	tokens = 128000;
	supports_tools = false;
}
