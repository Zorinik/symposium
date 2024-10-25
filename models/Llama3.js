import GroqModel from "./GroqModel.js";

export default class Llama3 extends GroqModel {
	name = 'llama-3.2-90b-vision-preview';
	label = 'llama-3';
	tokens = 128000;
}
