import OpenAIModel from "./OpenAIModel.js";

export default class GptO1 extends OpenAIModel {
	name = 'o1';
	label = 'gpt-o1';
	name_for_tiktoken = 'o1-mini';
	tokens = 200000;
	supports_structured_output = true;
}
