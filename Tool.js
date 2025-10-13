export default class Tool {
	name = '';

	async getFunctions() {
		return [];
	}

	async callFunction(thread, name, payload) {
		return {error: 'callFunction is yet to be implemented'};
	}

	async authorize(thread, name, payload) {
		return true;
	}

	async authorizeAlways(thread, name, payload) {
	}
}
