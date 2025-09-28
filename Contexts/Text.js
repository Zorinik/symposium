import Context from "../Context.js";

export default class Text extends Context {
	constructor(text, title = null) {
		super();
		this.text = text;
		this.title = title;
	}

	async getTitle() {
		return this.title;
	}

	async getText() {
		return this.text;
	}
}
