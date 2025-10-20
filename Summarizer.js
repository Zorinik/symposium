import Symposium from "./Symposium.js";
import ContextHandler from "./ContextHandler.js";

export default class Summarizer extends ContextHandler {
	constructor(threshold = 0.7, summary_length = 0.5) {
		super();
		this.threshold = threshold;
		this.summary_length = summary_length;
	}

	async handle(thread) {
		const model = Symposium.getModel(thread.state.model);
		if (!model)
			return thread;

		try {
			const tokens = await model.countTokens(thread);
			if (tokens >= model.tokens * this.threshold)
				return await this.summarize(model, thread, model.tokens * this.summary_length);
			else
				return thread;
		} catch (e) {
			console.error('Summarizer error: ' + String(e));
			return thread;
		}
	}

	async summarize(model, thread, maxLength) {
		let summaryThread = thread.clone(false);

		let currentStep = 'system';
		for (let message of thread.messages) {
			switch (currentStep) {
				case 'system':
					if (message.role !== 'system')
						currentStep = 'summary';
					break;
				case 'summary':
					if (message.role === 'user' && (await this.hasPassedLimit(model, summaryThread, maxLength))) {
						summaryThread = await this.doSummarize(summaryThread, maxLength);
						currentStep = 'retain';
					}
					break;
			}

			summaryThread.messages.push(message);
		}

		return summaryThread;
	}

	async hasPassedLimit(model, thread, maxLength) {
		const length = await model.countTokens(thread);
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
			force_function: 'summarize',
		});

		if (!summary)
			return false;

		let summarizedThread = thread.clone(false);
		for (let message of thread.messages) {
			if (message.role === 'system' && !message.tags.includes('summary')) {
				summarizedThread.messages.push(message);
			} else {
				const functionsResponse = Symposium.extractFunctionsFromResponse(summary);
				if (functionsResponse.length)
					throw new Error('Errore durante la generazione di un riassunto interno');

				summarizedThread.addMessage('system', "This is what happened until now:\n" + functionsResponse[0].summary, undefined, ['summary']);
				break;
			}
		}

		return summarizedThread;
	}
}
