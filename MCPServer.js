import Toolkit from "./Toolkit.js";

const PREFIX_SEPARATOR = '__';

export default class MCPServer extends Toolkit {
	constructor(config = {}) {
		super();

		if (!config || typeof config !== 'object')
			throw new Error('MCPServer config must be an object');
		if (!config.name || typeof config.name !== 'string')
			throw new Error('MCPServer config.name is required');

		this.config = config;
		this.serverName = config.name;
		this.name = 'mcp:' + this.serverName;

		this.client = null;
		this.transport = null;
		this._toolsByPrefixed = new Map();
	}

	async init(agent) {
		if (this.client)
			return;

		this.client = await this._connect();

		const list = await this.client.listTools();
		const tools = (list && list.tools) || [];
		for (const t of tools) {
			const prefixed = this.serverName + PREFIX_SEPARATOR + t.name;
			this._toolsByPrefixed.set(prefixed, {
				rawName: t.name,
				description: t.description || '',
				inputSchema: t.inputSchema || {type: 'object', properties: {}},
			});
		}
	}

	async _connect() {
		const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
		this.transport = await this._createTransport();

		const client = new Client({
			name: 'symposium',
			version: '3.1.0',
		});

		await client.connect(this.transport);
		return client;
	}

	async _createTransport() {
		const transport = this.config.transport || 'stdio';

		if (transport === 'stdio') {
			const {StdioClientTransport} = await import('@modelcontextprotocol/sdk/client/stdio.js');
			if (!this.config.command)
				throw new Error('MCPServer stdio transport requires a command');
			return new StdioClientTransport({
				command: this.config.command,
				args: this.config.args || [],
				env: this.config.env,
				cwd: this.config.cwd,
			});
		}

		if (transport === 'sse') {
			const {SSEClientTransport} = await import('@modelcontextprotocol/sdk/client/sse.js');
			if (!this.config.url)
				throw new Error('MCPServer sse transport requires a url');
			return new SSEClientTransport(new URL(this.config.url), {
				requestInit: this.config.headers ? {headers: this.config.headers} : undefined,
			});
		}

		if (transport === 'http') {
			const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
			if (!this.config.url)
				throw new Error('MCPServer http transport requires a url');
			return new StreamableHTTPClientTransport(new URL(this.config.url), {
				requestInit: this.config.headers ? {headers: this.config.headers} : undefined,
			});
		}

		if (transport && typeof transport === 'object' && typeof transport.connect === 'function')
			return transport;

		throw new Error('Unknown MCPServer transport: ' + transport);
	}

	async getTools() {
		const out = [];
		for (const [prefixed, entry] of this._toolsByPrefixed) {
			out.push({
				name: prefixed,
				description: entry.description,
				parameters: entry.inputSchema,
			});
		}
		return out;
	}

	async callTool(thread, name, payload) {
		const entry = this._toolsByPrefixed.get(name);
		if (!entry)
			return {error: `MCP tool ${name} not found on server ${this.serverName}`};

		const result = await this.client.callTool({
			name: entry.rawName,
			arguments: payload || {},
		});

		if (result && result.isError)
			throw new Error(MCPServer._renderContent(result.content) || 'MCP tool returned an error');

		return {content: result.content};
	}

	async listResources() {
		const list = await this.client.listResources();
		return (list && list.resources) || [];
	}

	async readResource(uri) {
		const result = await this.client.readResource({uri});
		const contents = (result && result.contents) || [];
		const parts = [];
		for (const c of contents) {
			if (typeof c.text === 'string')
				parts.push(c.text);
			else if (typeof c.blob === 'string')
				parts.push(c.blob);
		}
		return parts.join('\n');
	}

	async close() {
		if (this.client) {
			try {
				await this.client.close();
			} catch {}
			this.client = null;
		}
		this.transport = null;
		this._toolsByPrefixed.clear();
	}

	static _renderContent(content) {
		if (!Array.isArray(content))
			return '';
		const parts = [];
		for (const c of content) {
			if (c && typeof c.text === 'string')
				parts.push(c.text);
		}
		return parts.join('\n');
	}
}
