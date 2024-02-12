class Logger {
	listeners = [];
	logs = [];

	subscribe(callback) {
		this.listeners.push(callback);
	}

	async log(agent, type, payload) {
		this.logs.push({agent, type, payload});

		for (let listener of this.listeners)
			await listener.call(null, agent, type, payload);
	}
}

export default Logger;
