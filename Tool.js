export default class Tool {
	name = '';

	async getFunctions() {
		return [];
	}

	async callFunction(thread, name, payload) {
		return {error: 'callFunction is yet to be implemented'};
	}
}
