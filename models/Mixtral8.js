import GroqModel from "./GroqModel.js";

export default class Mixtral8 extends GroqModel {
	name = 'mixtral-8x7b-32768';
	label = 'mixtral-8';
	tokens = 32768;
}
