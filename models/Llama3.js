import GroqModel from "./GroqModel.js";

export default class Llama3 extends GroqModel {
	name = 'llama-3.3-70b-versatile';
	label = 'llama-3';
	tokens = 128000;
}
