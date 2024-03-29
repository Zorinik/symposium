export default class Middleware {
	name;
	agent;

	constructor(agent) {
		this.agent = agent;
	}

	async before_add(thread, user_message) {
		return true;
	}

	async before_exec(thread, user_message) {
		return true;
	}

	async after_exec(thread, user_message) {
		return true;
	}
}
