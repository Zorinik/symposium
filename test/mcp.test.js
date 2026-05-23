import {test} from 'node:test';
import assert from 'node:assert/strict';

import Agent from '../Agent.js';
import Symposium from '../Symposium.js';
import Model from '../Model.js';
import Message from '../Message.js';
import Thread from '../Thread.js';
import MCPServer from '../MCPServer.js';

class FakeMCPClient {
	constructor({tools = [], resources = [], resourceContents = {}} = {}) {
		this._tools = tools;
		this._resources = resources;
		this._resourceContents = resourceContents;
		this.callToolCalls = [];
		this.closed = false;
	}

	async listTools() {
		return {tools: this._tools};
	}

	async listResources() {
		return {resources: this._resources};
	}

	async callTool(args) {
		this.callToolCalls.push(args);
		const text = this._resourceContents[args.name] ?? ('ok:' + args.name);
		return {content: [{type: 'text', text}]};
	}

	async readResource({uri}) {
		const text = this._resourceContents[uri] ?? ('contents of ' + uri);
		return {contents: [{uri, text}]};
	}

	async close() {
		this.closed = true;
	}
}

class FakeMCPServer extends MCPServer {
	constructor(config, fakeClient) {
		super(config);
		this._fakeClient = fakeClient;
	}

	async _connect() {
		return this._fakeClient;
	}
}

// Minimal scripted model so the agent can be instantiated and getTools() probed
// without needing real provider SDKs.
class ScriptedModel extends Model {
	constructor(label, script = []) {
		super();
		this.label = label;
		this.script = script;
		this.calls = 0;
	}
	async getModels() {
		return new Map([[this.label, {name: this.label, tokens: 1000, tools: true, structured_output: false}]]);
	}
	async *generate(_model, _thread, _functions, _options) {
		const turn = this.script[this.calls++];
		if (!turn) throw new Error('No more scripted turns');
		for (const delta of turn.deltas || []) yield delta;
		return turn.messages;
	}
}

async function makeAgent(label = 'fake-mcp') {
	await Symposium.loadModel(new ScriptedModel(label, [{
		deltas: [],
		messages: [new Message('assistant', [{type: 'text', content: 'noop'}])],
	}]));
	const agent = new Agent();
	agent.default_model = label;
	await agent.init();
	return agent;
}

test('MCPServer prefixes tool names with the server name', async () => {
	const agent = await makeAgent('fake-mcp-prefix');
	const client = new FakeMCPClient({
		tools: [
			{name: 'search', description: 'search the repo', inputSchema: {type: 'object', properties: {q: {type: 'string'}}}},
			{name: 'read_file', description: 'read a file', inputSchema: {type: 'object', properties: {path: {type: 'string'}}}},
		],
	});
	const server = new FakeMCPServer({name: 'github', transport: 'stdio', command: 'noop'}, client);
	await agent.addToolkit(server);

	const fns = await server.getTools();
	const names = fns.map(f => f.name).sort();
	assert.deepEqual(names, ['github__read_file', 'github__search']);

	const search = fns.find(f => f.name === 'github__search');
	assert.equal(search.description, 'search the repo');
	assert.deepEqual(search.parameters, {type: 'object', properties: {q: {type: 'string'}}});
});

test('two MCPServers with colliding raw tool names coexist via prefixing', async () => {
	const agent = await makeAgent('fake-mcp-collide');

	const ghClient = new FakeMCPClient({tools: [{name: 'search', description: 'gh search'}]});
	const fsClient = new FakeMCPClient({tools: [{name: 'search', description: 'fs search'}]});

	const gh = new FakeMCPServer({name: 'github', transport: 'stdio', command: 'noop'}, ghClient);
	const fs = new FakeMCPServer({name: 'fs', transport: 'stdio', command: 'noop'}, fsClient);

	await agent.addToolkit(gh);
	await agent.addToolkit(fs);

	const tools = await agent.getTools(false);
	assert.ok(tools.has('github__search'));
	assert.ok(tools.has('fs__search'));

	const thread = new Thread('test-collide', agent);
	thread.state = {model: 'fake-mcp-collide'};

	await tools.get('github__search').toolkit.callTool(thread, 'github__search', {q: 'hi'});
	await tools.get('fs__search').toolkit.callTool(thread, 'fs__search', {q: 'hi'});

	assert.deepEqual(ghClient.callToolCalls, [{name: 'search', arguments: {q: 'hi'}}]);
	assert.deepEqual(fsClient.callToolCalls, [{name: 'search', arguments: {q: 'hi'}}]);
});

test('MCPServer.callTool strips the prefix and forwards to client.callTool', async () => {
	const agent = await makeAgent('fake-mcp-forward');
	const client = new FakeMCPClient({tools: [{name: 'do_thing', description: '', inputSchema: {type: 'object', properties: {}}}]});
	const server = new FakeMCPServer({name: 'svc', transport: 'stdio', command: 'noop'}, client);
	await agent.addToolkit(server);

	const thread = new Thread('test-forward', agent);
	thread.state = {model: 'fake-mcp-forward'};

	const result = await server.callTool(thread, 'svc__do_thing', {x: 1});

	assert.deepEqual(client.callToolCalls, [{name: 'do_thing', arguments: {x: 1}}]);
	assert.ok(result.content);
	assert.equal(result.content[0].text, 'ok:do_thing');
});

test('MCPServer.callTool throws when MCP result has isError', async () => {
	const agent = await makeAgent('fake-mcp-error');
	const client = new FakeMCPClient({tools: [{name: 'broken'}]});
	client.callTool = async () => ({isError: true, content: [{type: 'text', text: 'boom'}]});

	const server = new FakeMCPServer({name: 'svc', transport: 'stdio', command: 'noop'}, client);
	await agent.addToolkit(server);

	const thread = new Thread('test-error', agent);
	thread.state = {model: 'fake-mcp-error'};

	await assert.rejects(
		() => server.callTool(thread, 'svc__broken', {}),
		/boom/,
	);
});

test('addMCPServer with resources:true registers each resource as an on_request context and auto-injects get_context', async () => {
	const agent = await makeAgent('fake-mcp-res');
	const client = new FakeMCPClient({
		tools: [{name: 'noop_tool', description: '', inputSchema: {type: 'object', properties: {}}}],
		resources: [
			{uri: 'mem://a', name: 'doc-a', description: 'first doc'},
			{uri: 'mem://b', name: 'doc-b', description: 'second doc'},
		],
		resourceContents: {'mem://a': 'AAA', 'mem://b': 'BBB'},
	});

	// Replicate addMCPServer manually but with the test subclass so we can inject the fake client.
	const server = new FakeMCPServer({name: 'svc', transport: 'stdio', command: 'noop', resources: true}, client);
	await agent.addToolkit(server);
	const {default: MCPResource} = await import('../Contexts/MCPResource.js');
	for (const res of await server.listResources()) {
		await agent.addContext(new MCPResource(server, res), {
			type: 'on_request',
			description: res.description || '',
		});
	}

	const thread = new Thread('test-res', agent);
	thread.state = {model: 'fake-mcp-res'};
	await agent.initThread(thread);

	assert.ok(agent.toolkits.has('get_context'), 'get_context toolkit should be auto-injected');

	const titles = agent.context.map(c => c.title).sort();
	assert.deepEqual(titles, ['doc-a', 'doc-b']);

	const docA = agent.context.find(c => c.title === 'doc-a');
	assert.equal(docA.options.type, 'on_request');
	assert.equal(docA.options.description, 'first doc');
	assert.equal(await docA.context.getText(), 'AAA');
});

test('MCPServer.close() shuts the client down', async () => {
	const agent = await makeAgent('fake-mcp-close');
	const client = new FakeMCPClient({tools: [{name: 'x'}]});
	const server = new FakeMCPServer({name: 'svc', transport: 'stdio', command: 'noop'}, client);
	await agent.addToolkit(server);

	await server.close();
	assert.equal(client.closed, true);
	assert.equal(server.client, null);
});

test('MCPServer constructor validates config', () => {
	assert.throws(() => new MCPServer({}), /config\.name is required/);
	assert.throws(() => new MCPServer(null), /config must be an object/);
});
