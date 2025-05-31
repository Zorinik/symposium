import AnthropicModel from "./AnthropicModel.js";

export default class Claude4Sonnet extends AnthropicModel {
	name = 'claude-sonnet-4-20250514';
	label = 'claude-4-sonnet';
	tokens = 200000;
}
