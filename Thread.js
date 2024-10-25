import Message from "./Message.js";
import Symposium from "./Symposium.js";

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

		const conv = await Symposium.storage.get('thread-' + this.id);
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
		await Symposium.storage.set('thread-' + this.id, {
			state: this.state,
			messages: this.messages,
		});
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
