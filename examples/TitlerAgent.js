import {Agent} from "symposium";

export default class TitlerAgent extends Agent {
	default_model = 'gpt-4o';

	constructor(options) {
		super(options);
		this.name = 'Titler';
	}

	async init() {
		await super.init();

		this.utility = {
			type: 'text',
		};
	}

	async doInitThread(thread) {
		await thread.addMessage('system',
			`Your task is to observe the following message, which represents the beginning of a conversation from the user, and give a title of a few words (maximum 30 characters) that describes it as accurately as possible. Even a single word is fine, if necessary.
			Do not write anything else in your message, but only and exclusively the title.`
		);
	}
}
