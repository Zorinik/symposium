import OpenAIModel from "./OpenAIModel.js";

export default class Gpt5Mini extends OpenAIModel {
	name = 'gpt-5-mini';
	label = 'gpt-5-mini';
	tokens = 400000;
	supports_structured_output = true;
}
