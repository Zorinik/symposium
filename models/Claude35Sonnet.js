import AnthropicModel from "./AnthropicModel.js";

export default class Claude35Sonnet extends AnthropicModel {
	name = 'claude-3-5-sonnet-20240620';
	label = 'claude-3.5-sonnet';
	tokens = 200000;
}
