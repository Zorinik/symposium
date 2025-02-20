import {Tool} from "symposium";

export default class GenericTool extends Tool {
	name = 'GenericTool';

	async getFunctions() {
		return [
			{
				name: `create_todo`,
				description: `Create a new TODO`,
				parameters: {
					type: 'object',
					properties: {
						title: {
							type: 'string',
							description: 'Title of the TODO',
						},
						description: {
							type: 'string',
							description: 'Description of the TODO',
						},
						due_date: {
							type: 'string',
							description: 'Due date of the TODO',
						},
					},
					required: ['title', 'description', 'due_date'],
				},
			}
		];
	}

	async callFunction(thread, name, payload) {
		try {
			// Implement your function here

			throw new Error(`Unknown function: ${name}`);
		} catch (error) {
			return {error: error.response?.body || error};
		}
	}
}
