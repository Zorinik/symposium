import Context from "../Context.js";

export default class MCPResource extends Context {
	constructor(server, resource) {
		super();
		this.server = server;
		this.resource = resource;
		this.uri = resource.uri;
		this.title = resource.name || resource.uri;
	}

	async getTitle() {
		return this.title;
	}

	async getText() {
		return this.server.readResource(this.uri);
	}
}
