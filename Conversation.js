import Message from "./Message.js";
import Redis from "@travio/redis";

export default class Conversation {
	id;
	reply;
	messages = [];
	state = {};
	auth = new Map();

	constructor(id) {
		this.id = id;
	}

	clone(keepMessages = true) {
		let newConversation = new Conversation(this.id);
		newConversation.reply = this.reply;
		newConversation.state = this.state;
		if (keepMessages)
			newConversation.messages = [...this.messages];
		return newConversation;
	}

	async flush() {
		this.messages = [];
	}

	async loadState() {
		await this.flush();
		this.state = {};

		const conv = await Redis.get('conversation-' + this.id);
		if (conv) {
			this.auth = new Map(conv.auth || []);
			this.state = conv.state || {};
			this.messages = conv.messages.map(m => (new Message(m.role, m.text, m.name, m.function_call, m.tags || [])));
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
		await Redis.set('conversation-' + this.id, {
			auth: [...this.auth.entries()],
			state: this.state,
			messages: this.messages,
		}, 0);
	}

	getMessagesJson() {
		return this.messages.map(m => ({
			role: m.role,
			content: m.text,
			name: m.name || undefined,
			function_call: m.function_call || undefined,
		}));
	}

	addSystemMessage(text, tags = []) {
		this.messages.push(new Message('system', text, null, null, tags));
	}

	addUserMessage(text, name = null, tags = []) {
		this.messages.push(new Message('user', text, name, null, tags));
	}

	addAssistantMessage(text, function_call = null, tags = []) {
		this.messages.push(new Message('assistant', text, null, function_call, tags));
	}

	addFunctionMessage(response, name = null, tags = []) {
		this.messages.push(new Message('function', JSON.stringify(response), name, null, tags));
	}

	removeMessagesWithTag(tag) {
		this.messages = this.messages.filter(m => !m.tags.includes(tag));
	}
}
