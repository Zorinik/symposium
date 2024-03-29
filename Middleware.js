export default class Middleware {
	name;
	agent;

	constructor(agent) {
		this.agent = agent;
	}

	async before_exec(thread) {
		return true;
	}

	async after_exec(thread) {
		return true;
	}
}
