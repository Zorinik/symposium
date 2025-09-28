import Tool from "./Tool.js";

export default class GetContextTool extends Tool {
	name = 'get_context';

	constructor(agent) {
		super();
		this.agent = agent;
	}

	async getFunctions() {
		return [
			{
				name: 'get_context',
				description: 'Get the text from a specific context snippet',
				parameters: {
					type: 'object',
					properties: {
						title: {
							type: 'string',
						},
					},
					required: ['title'],
				},
			}
		];
	}

	async callFunction(thread, name, payload) {
		if (name !== 'get_context')
			return {error: `Function ${name} not found`};

		const title = payload.title;
		const context = this.agent.context.find(c => c.title === title && c.options.type === 'on_request');
		if (!context)
			return {error: `Context with title ${title} not found`};

		return {
			context: await context.context.getText(),
		};
	}
}
