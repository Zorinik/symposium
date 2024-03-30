export default class Model {
	type = 'llm';
	name;
	name_for_tiktoken;
	label;
	tokens;
	supports_tools = false;

	constructor() {
		if (!this.label)
			this.label = this.name;
		if (!this.name_for_tiktoken)
			this.name_for_tiktoken = this.name;
	}

	async generate(thread) {
		return null;
	}
}
