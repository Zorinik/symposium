import Symposium from "./Symposium.js";
import MemoryHandler from "./MemoryHandler.js";
import {encoding_for_model} from "tiktoken";

export default class Summarizer extends MemoryHandler {
	constructor(threshold = 0.7, summary_length = 0.5) {
		super();
		this.threshold = threshold;
		this.summary_length = summary_length;
	}

	async handle(thread) {
		const model = Symposium.getModelByName(thread.state.model);
		if (!model)
			return thread;

		const encoder = encoding_for_model(model.name_for_tiktoken);
		const tokens = this.countTokens(encoder, thread);
		if (tokens >= model.tokens * this.threshold)
			return await this.summarize(encoder, thread, model.tokens * this.summary_length);
		else
			return thread;
	}

	countTokens(encoder, thread) {
		return encoder.encode(thread.messages.map(m => m.text).join('')).length;
	}

	async summarize(encoder, thread, maxLength) {
		let summaryThread = thread.clone(false);

		let currentStep = 'system';
		for (let message of thread.messages) {
			switch (currentStep) {
				case 'system':
					if (message.role !== 'system')
						currentStep = 'summary';
					break;
				case 'summary':
					if (message.role === 'user' && this.hasPassedLimit(encoder, summaryThread, maxLength)) {
						summaryThread = await this.doSummarize(summaryThread, maxLength);
						currentStep = 'retain';
					}
					break;
			}

			summaryThread.messages.push(message);
		}

		return summaryThread;
	}

	hasPassedLimit(encoder, thread, maxLength) {
		let length = this.countTokens(encoder, thread);
		return length > maxLength;
	}

	async doSummarize(thread, maxLength) {
		thread.addMessage('system', 'Summarize the conversation up to this moment.');
		const summary = await this.agent.generateCompletion(thread, {
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

		// TODO: sistemare con nuova interfaccia
		let summarizedThread = thread.clone(false);
		for (let message of thread.messages) {
			if (message.role === 'system' && !message.tags.includes('summary')) {
				summarizedThread.messages.push(message);
			} else {
				summarizedThread.addMessage('system', "This is what happened until now:\n" + summary.function_call.arguments.summary, ['summary']);
				break;
			}
		}

		return summarizedThread;
	}
}
