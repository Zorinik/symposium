import AnthropicModel from "./AnthropicModel.js";

export default class Claude4Opus extends AnthropicModel {
	name = 'claude-opus-4-20250514';
	label = 'claude-4-opus';
	tokens = 200000;
}
