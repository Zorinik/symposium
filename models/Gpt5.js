import OpenAIModel from "./OpenAIModel.js";

export default class Gpt5 extends OpenAIModel {
	name = 'gpt-5';
	label = 'gpt-5';
	tokens = 400000;
	supports_structured_output = true;
}
