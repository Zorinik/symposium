import {Agent, Symposium} from "symposium";
import MultiAgentTool from "./Tools/MultiAgentTool.js";

export default class MultiAgent extends Agent {
	default_model = 'gpt-4o';

	constructor(options = {}) {
		options = {
			agents: [],
			...options,
		};

		super(options);
		this.name = 'Multi Agent';

		this.internalInterface = {
			name: 'agent-vs-agent',
			promises: [],
			init: async () => {
			},
			message: async (thread, msg) => {
			},
			output: async (thread, msg) => {
			},
			error: async (thread, error) => {
			},
		};

		this.addTool(new MultiAgentTool(this.options.agents));
	}

	async init() {
		await super.init();

		for (let agent of this.options.agents) {
			agent.options.interfaces = [this.internalInterface];
			await agent.init();
		}
	}

	async reset(thread) {
		await super.reset(thread);

		for (let agent of this.options.agents) {
			const sub_thread = await agent.getThread(thread.id, 'agent-vs-agent');
			await agent.reset(sub_thread);
		}
	}

	async doInitThread(thread) {
		const memory = await this.tools.get('Memory').get();

		await thread.addMessage('system',
			`You are a helpful assistant, assist the user using the tools you are provided with.
			In order to do so, you have a series of agents at your service, with which you can communicate behind the scenes to provide the user with what they asked for. You can communicate with them through their respective tools that you have.
			You can talk to the agents in natural language, and also respond to them multiple times if necessary. Try to use clear and direct language with precise instructions when talking to an agent.
			
			At the end of each task, when the agent has completed its function, remember to reset the conversation with the agent to save memory. You can do this using the "reset" function.
			
			Interrogate them only if the user asks to perform tasks that concern them, otherwise you can rely on your knowledge to respond directly.
			
			Current time is: ${(new Date()).toLocaleDateString()}`,
		);

		for (let agent of this.options.agents) {
			const sub_thread = await agent.getThread(thread.id, 'agent-vs-agent');
			if (sub_thread) {
				await sub_thread.flush();
				await agent.initThread(sub_thread);
			}
		}
	}

	async beforeExecute(thread) {
		if (this.options.reasoning) {
			let reasoning = await this.generateCompletion(thread, {
				functions: [
					{
						name: 'ragionamento',
						description: 'Before responding to the user, ask yourself what needs to be done and if you need to ask for more info.',
						parameters: {
							type: 'object',
							properties: {
								ragionamento: {
									type: 'string',
									description: 'Reflect on the request just made. What do you need to do to fulfill the user\'s request? These are your thoughts and the user cannot see them.',
								}
							},
							required: ['ragionamento'],
						}
					},
					...(await this.getFunctions()),
				],
				force_function: 'ragionamento',
			});

			if (reasoning) {
				reasoning = Symposium.extractFunctionsFromResponse(reasoning)[0];
				await this.log('reasoning', reasoning);
				thread.addMessage('assistant', "[Thinking] " + reasoning.ragionamento + "\n");
			}
		}

		return thread;
	}

	async getPromptWordsForTranscription(thread) {
		let words = [this.name];
		for (let agent of this.options.agents) {
			const sub_thread = await agent.getThread(thread.id, 'agent-vs-agent');
			words = [...words, ...(await agent.getPromptWordsForTranscription(sub_thread))];
		}
		return words;
	}
}
