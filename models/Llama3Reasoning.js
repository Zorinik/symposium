import GroqModel from "./GroqModel.js";

export default class Llama3Reasoning extends GroqModel {
	name = 'llama-3.1-405b-reasoning';
	label = 'llama-3-reasoning';
	tokens = 131072;
}
