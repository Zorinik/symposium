import Context from "../Context.js";

export default class Text extends Context {
	constructor(text) {
		super();
		this.text = text;
	}

	async getText() {
		return this.text;
	}
}
