export default class Model {
	vendor;
	name;
	name_for_tiktoken;
	label;
	tokens;
	supports_tools = false;

	constructor() {
		if (!this.name_for_tiktoken)
			this.name_for_tiktoken = this.name;
	}

	async generate(thread) {
		return null;
	}
}
