import AnthropicModel from "./AnthropicModel.js";

export default class Claude3Sonnet extends AnthropicModel {
	name = 'claude-3-sonnet-20240229';
	label = 'claude-3-sonnet';
	tokens = 200000;
}
