import AnthropicModel from "./AnthropicModel.js";

export default class Claude37Sonnet extends AnthropicModel {
	name = 'claude-3-7-sonnet-latest';
	label = 'claude-3.7-sonnet';
	tokens = 200000;
}
