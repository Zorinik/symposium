class Model {
	name;
	name_for_tiktoken;
	label;
	tokens;

	constructor(name, label, tokens, name_for_tiktoken = null) {
		this.name = name;
		this.label = label;
		this.tokens = tokens;
		this.name_for_tiktoken = name_for_tiktoken || name;
	}
}

export default Model;
