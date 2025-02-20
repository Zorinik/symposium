import {Agent, Symposium} from "symposium";
import GenericTool from "./Tools/GenericTool.js";

export default class ChatAgent extends Agent {
	default_model = 'gpt-4o';

	constructor(options = {}) {
		super(options);

		this.name = 'ChatAgent';

		this.addTool(new GenericTool());
	}

	async doInitThread(thread) {
		await thread.addMessage('system',
			`You are a helpful assistant, assist the user using the tools you are provided with.
			Current time is: ${(new Date()).toLocaleDateString()}`
		);
	}
}
