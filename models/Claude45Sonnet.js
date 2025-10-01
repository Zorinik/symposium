import AnthropicModel from "./AnthropicModel.js";

export default class Claude4Sonnet extends AnthropicModel {
	name = 'claude-sonnet-4-5-20250929';
	label = 'claude-4.5-sonnet';
	tokens = 200000;
}
