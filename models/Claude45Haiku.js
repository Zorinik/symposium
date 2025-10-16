import AnthropicModel from "./AnthropicModel.js";

export default class Claude45Haiku extends AnthropicModel {
	name = 'claude-haiku-4-5-20251001';
	label = 'claude-4.5-haiku';
	tokens = 200000;
}
