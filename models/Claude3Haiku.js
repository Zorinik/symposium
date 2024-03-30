import AnthropicModel from "./AnthropicModel.js";

export default class Claude3Haiku extends AnthropicModel {
	name = 'claude-3-haiku-20240307';
	label = 'claude-3-haiku';
	tokens = 200000;
}
