class Message {
	role;
	text;
	name;
	function_call;
	tags = [];

	constructor(role, text, name = null, function_call = null, tags = []) {
		this.role = role;
		this.text = text;
		this.name = name;
		this.function_call = function_call;
		this.tags = tags;
	}
}

export default Message;
