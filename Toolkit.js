export default class Toolkit {
	name = '';

	async init(agent) {
	}

	async getTools() {
		return [];
	}

	async callTool(thread, name, payload) {
		return {error: 'callTool is yet to be implemented'};
	}

	async authorize(thread, name, payload) {
		return true;
	}

	async authorizeAlways(thread, name, payload) {
	}
}
