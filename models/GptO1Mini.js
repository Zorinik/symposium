import OpenAIModel from "./OpenAIModel.js";

export default class GptO1Mini extends OpenAIModel {
	name = 'o1-mini';
	label = 'gpt-o1-mini';
	name_for_tiktoken = 'o1-mini';
	tokens = 128000;
	supports_structured_output = true;
	system_role_name = 'developer';
}
