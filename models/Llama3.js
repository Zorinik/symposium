import GroqModel from "./GroqModel.js";

export default class Llama3 extends GroqModel {
	name = 'llama3-70b-8192';
	label = 'llama-3';
	tokens = 8192;
}
