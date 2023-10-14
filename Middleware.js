class Middleware {
	name;
	agent;

	constructor(agent) {
		this.agent = agent;
	}

	async before_add(conversation, user_message) {
		return true;
	}

	async before_exec(conversation, user_message) {
		return true;
	}

	async after_exec(conversation, user_message) {
		return true;
	}
}

export {Middleware};
