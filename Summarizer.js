import Symposium from "./Symposium.js";
import MemoryHandler from "./MemoryHandler.js";
import {encoding_for_model} from "tiktoken";

export default class Summarizer extends MemoryHandler {
	constructor(threshold = 0.7, summary_length = 0.5) {
		super();
		this.threshold = threshold;
		this.summary_length = summary_length;
	}

	async handle(conversation) {
		const model = Symposium.getModelByName(conversation.state.model);
		if (!model)
			return conversation;

		const encoder = encoding_for_model(model.name_for_tiktoken);
		const tokens = this.countTokens(encoder, conversation);
		if (tokens >= model.tokens * this.threshold)
			return await this.summarize(encoder, conversation, model.tokens * this.summary_length);
		else
			return conversation;
	}

	countTokens(encoder, conversation) {
		return encoder.encode(conversation.messages.map(m => m.text).join('')).length;
	}

	async summarize(encoder, conversation, maxLength) {
		let summaryConversation = conversation.clone(false);

		let currentStep = 'system';
		for (let message of conversation.messages) {
			switch (currentStep) {
				case 'system':
					if (message.role !== 'system')
						currentStep = 'summary';
					break;
				case 'summary':
					if (message.role === 'user' && this.hasPassedLimit(encoder, summaryConversation, maxLength)) {
						summaryConversation = await this.doSummarize(summaryConversation, maxLength);
						currentStep = 'retain';
					}
					break;
			}

			summaryConversation.messages.push(message);
		}

		return summaryConversation;
	}

	hasPassedLimit(encoder, conversation, maxLength) {
		let length = this.countTokens(encoder, conversation);
		return length > maxLength;
	}

	async doSummarize(conversation, maxLength) {
		conversation.addSystemMessage('Summarize the conversation up to this moment.');
		const summary = await this.agent.generateCompletion(conversation, {
			functions: [
				{
					name: 'summarize',
					description: 'Generate a summary of the conversation in ' + Math.round(maxLength / 2) + ' words at most, in a way that it is easy for you to keep track of the important info. Do not omit relevant information you need to remember in order to continue the conversation.',
					parameters: {
						type: 'object',
						properties: {
							summary: {
								type: 'string'
							}
						},
						required: ['summary'],
					}
				},
			],
			function_call: {name: 'summarize'},
		});

		if (!summary)
			return false;

		let summarizedConversation = conversation.clone(false);
		for (let message of conversation.messages) {
			if (message.role === 'system' && !message.tags.includes('summary')) {
				summarizedConversation.messages.push(message);
			} else {
				summarizedConversation.addSystemMessage("This is what happened until now:\n" + summary.function_call.arguments.summary, ['summary']);
				break;
			}
		}

		return summarizedConversation;
	}
}
