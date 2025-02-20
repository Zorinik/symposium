import {Tool} from "symposium";

export default class MultiAgentTool extends Tool {
	name = 'MultiAgentTool';
	agents;

	constructor(agents) {
		super();
		this.agents = agents;
	}

	async getFunctions() {
		return [
			...this.agents.map(a => ({
				name: a.name,
				description: a.description,
				parameters: {
					type: 'object',
					properties: {
						message: {
							type: 'string',
							description: 'The message to send to the agent'
						}
					}
				}
			})),
			{
				name: 'reset',
				description: 'Reset an agent\'s memory to start the conversation again',
				parameters: {
					type: 'object',
					properties: {
						agent: {
							type: 'string',
							description: 'The name of the agent to reset'
						}
					}
				}
			}
		];
	}

	async callFunction(thread, name, payload) {
		try {
			if (name === 'reset') {
				const agent = this.agents.find(a => a.name === payload.agent);
				if (!agent)
					throw new Error('No agent named "' + payload.agent + '"');

				const sub_thread = await agent.getThread(thread.id, 'agent-vs-agent');

				await agent.reset(sub_thread);

				return {success: true};
			} else {
				const agent = this.agents.find(a => a.name === name);
				if (!agent)
					throw new Error('No agent named "' + name + '"');

				return await (new Promise(async (resolve, reject) => {
					try {
						const sub_thread = await agent.getThread(thread.id, 'agent-vs-agent');

						await agent.message(sub_thread, 'agent-vs-agent', payload.message, msg => {
							resolve({reply: msg});
						});
					} catch (e) {
						console.error(JSON.stringify(e));
						reject(e);
					}
				}));
			}
		} catch (error) {
			return {error};
		}
	}
}
