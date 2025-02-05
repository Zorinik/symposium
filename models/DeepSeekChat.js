import DeepSeekModel from "./DeepSeekModel.js";

export default class DeepSeekChat extends DeepSeekModel {
	name = 'deepseek-chat';
	label = 'deepseek-chat';
	tokens = 64000;
}
