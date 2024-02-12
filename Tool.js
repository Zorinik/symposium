class Tool {
	name = '';

	async getFunctions() {
		return [];
	}

	async callFunction(conversation, name, payload) {
		return {error: 'callFunction is yet to be implemented'};
	}
}

export default Tool;
