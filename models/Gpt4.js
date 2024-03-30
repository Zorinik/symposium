import OpenAIModel from "./OpenAIModel.js";

export default class Gpt4 extends OpenAIModel {
	name = 'gpt-4';
	label = 'gpt-4';
	tokens = 8192;
}
