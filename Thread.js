import Message from "./Message.js";
import Symposium from "./Symposium.js";

export default class Thread {
	id;
	unique;
	agent;
	messages = [];
	state = {};
	interface = null;

	constructor(id, i, agent) {
		this.id = id;
		this.unique = agent.name + '-' + i + '-' + id;
		this.agent = agent;
		this.interface = i;
	}

	clone(keepMessages = true) {
		let newThread = new Thread(this.id, this.interface, this.agent);
		newThread.interface = this.interface;
		newThread.state = this.state;
		if (keepMessages)
			newThread.messages = [...this.messages];
		return newThread;
	}

	changeId(id) {
		this.id = id;
		this.unique = this.agent.name + '-' + this.interface + '-' + id;
	}

	async flush() {
		this.messages = [];
	}

	async loadState() {
		await this.flush();
		this.state = {};

		const conv = Symposium.storage ? (await Symposium.storage.get('thread-' + this.unique)) : null;
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
		if (Symposium.storage) {
			await Symposium.storage.set('thread-' + this.unique, {
				state: this.state,
				messages: this.messages,
			});
		}
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
