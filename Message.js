export default class Message {
	role;
	content = [];
	name = undefined;
	tags = [];

	constructor(role, content = [], name = undefined, tags = []) {
		this.role = role;
		this.name = name;
		this.tags = tags;

		if (typeof content === 'string') {
			this.content = [
				{
					type: 'text',
					content,
				},
			];
		} else if (typeof content === 'object') {
			this.content = Array.isArray(content) ? content : [content];
		} else {
			throw new Error('Unrecognized message type');
		}
	}
}
