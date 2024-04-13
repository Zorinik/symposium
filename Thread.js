import Message from "./Message.js";
import Redis from "@travio/redis";

export default class Thread {
	id;
	agent;
	reply;
	messages = [];
	state = {};

	constructor(id, agent) {
		this.id = id;
		this.agent = agent;
	}

	clone(keepMessages = true) {
		let newThread = new Thread(this.id, this.agent);
		newThread.reply = this.reply;
		newThread.state = this.state;
		if (keepMessages)
			newThread.messages = [...this.messages];
		return newThread;
	}

	async flush() {
		this.messages = [];
	}

	async loadState() {
		await this.flush();
		this.state = {};

		const conv = await Redis.get('thread-' + this.id);
		if (conv) {
			this.state = conv.state || {};
			this.messages = conv.messages.map(m => new Message(m.role, m.content, m.name, m.tags));
			return true;
		} else {
			return false;
		}
	}

	async setState(state, save = true) {
		this.state = {...this.state, ...state};
		if (save)
			await this.storeState();
	}

	async storeState() {
		await Redis.set('thread-' + this.id, {
			state: this.state,
			messages: this.messages,
		}, process.env.THREADS_TTL || 604800);
	}

	addDirectMessage(message) {
		this.messages.push(message);
	}

	addMessage(role, content = [], name = undefined, tags = []) {
		this.addDirectMessage(new Message(role, content, name, tags));
	}

	removeMessagesWithTag(tag) {
		this.messages = this.messages.filter(m => !m.tags.includes(tag));
	}
}
