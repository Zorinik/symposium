import OpenAIModel from "./OpenAIModel.js";

export default class Gpt35 extends OpenAIModel {
	vendor = 'openai';
	name = 'gpt-3.5-turbo';
	label = 'gpt-3.5';
	tokens = 16384;
}
