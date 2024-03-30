import AnthropicModel from "./AnthropicModel.js";

export default class Claude3Opus extends AnthropicModel {
	name = 'claude-3-opus-20240229';
	label = 'claude-3-opus';
	tokens = 200000;
}
