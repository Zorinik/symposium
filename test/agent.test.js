import {test} from 'node:test';
import assert from 'node:assert/strict';

import Agent from '../Agent.js';
import Symposium from '../Symposium.js';
import Model from '../Model.js';
import Message from '../Message.js';
import Thread from '../Thread.js';
import Toolkit from '../Toolkit.js';

import {drain} from './helpers/mockSdk.js';
import {createInputChannel} from '../InputChannel.js';

// A FakeModel whose generate() is supplied per-instance, so each test can script its own behavior.
class ScriptedModel extends Model {
	constructor(label, script) {
		super();
		this.label = label;
		this.script = script;
		this.calls = 0;
	}

	async getModels() {
		return new Map([
			[this.label, {
				name: this.label,
				tokens: 1000,
				tools: true,
				structured_output: false,
			}],
		]);
	}

	async *generate(_model, _thread, _functions, _options) {
		const turn = this.script[this.calls++];
		if (!turn)
			throw new Error('No more scripted turns for model ' + this.label);
		if (turn.throwBefore)
			throw turn.throwBefore;
		for (const delta of turn.deltas || []) {
			yield delta;
			if (delta._thenThrow)
				throw delta._thenThrow;
		}
		return turn.messages;
	}
}

async function makeThread(agent, label) {
	const thread = new Thread('test-' + label, agent);
	thread.state = {model: label};
	return thread;
}

// ────────────────────────────────────────────────────────────────────────────────
// Preserved from Phase 1: generateCompletion still drains the model generator
// and returns Message[] as its async-generator return value.
// ────────────────────────────────────────────────────────────────────────────────
test('Agent.generateCompletion forwards text_delta as chunks and returns Message[]', async () => {
	const label = 'fake-gen-completion';
	await Symposium.loadModel(new ScriptedModel(label, [{
		deltas: [
			{type: 'text_delta', content: 'Hello'},
			{type: 'text_delta', content: ' world'},
		],
		messages: [new Message('assistant', [{type: 'text', content: 'Hello world'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const {deltas, value} = await drain(agent.generateCompletion(thread));

	assert.deepEqual(deltas, [
		{type: 'chunk', content: 'Hello'},
		{type: 'chunk', content: ' world'},
	]);
	assert.equal(value.length, 1);
	assert.ok(value[0] instanceof Message);
	assert.equal(value[0].role, 'assistant');
	assert.deepEqual(value[0].content, [{type: 'text', content: 'Hello world'}]);
});

// ────────────────────────────────────────────────────────────────────────────────
// Chat happy path
// ────────────────────────────────────────────────────────────────────────────────
test('chat agent.message() yields start → chunk* → output → end', async () => {
	const label = 'fake-chat-happy';
	await Symposium.loadModel(new ScriptedModel(label, [{
		deltas: [
			{type: 'text_delta', content: 'Hi'},
			{type: 'text_delta', content: ' there'},
		],
		messages: [new Message('assistant', [{type: 'text', content: 'Hi there'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	for await (const ev of agent.message('Hello', thread))
		events.push(ev);

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'chunk', 'chunk', 'output', 'end']);
	assert.equal(events[1].content, 'Hi');
	assert.equal(events[2].content, ' there');
	assert.deepEqual(events[3].content, {type: 'text', content: 'Hi there'});
});

// ────────────────────────────────────────────────────────────────────────────────
// Tool loop: first turn calls a function; second turn answers in text.
// ────────────────────────────────────────────────────────────────────────────────
test('chat agent runs a tool then yields tool/tool_response/output', async () => {
	const label = 'fake-chat-tool';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [],
			messages: [new Message('assistant', [
				{type: 'tool_call', content: [{id: 'call_1', name: 'echo', arguments: {msg: 'hi'}}]},
			])],
		},
		{
			deltas: [{type: 'text_delta', content: 'Done'}],
			messages: [new Message('assistant', [{type: 'text', content: 'Done'}])],
		},
	]));

	class EchoTool extends Toolkit {
		name = 'echo';
		async getTools() {
			return [{name: 'echo', description: 'echoes', parameters: {type: 'object', properties: {msg: {type: 'string'}}}}];
		}
		async callTool(_thread, _name, payload) {
			return {echoed: payload.msg};
		}
	}

	const agent = new Agent();
	agent.default_model = label;
	await agent.addToolkit(new EchoTool());
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	for await (const ev of agent.message('say hi', thread))
		events.push(ev);

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'tool', 'tool_response', 'chunk', 'output', 'end']);

	const toolEv = events[1];
	assert.equal(toolEv.name, 'echo');
	assert.equal(toolEv.id, 'call_1');
	assert.deepEqual(toolEv.arguments, {msg: 'hi'});

	const respEv = events[2];
	assert.equal(respEv.success, true);
	assert.deepEqual(respEv.response, {echoed: 'hi'});
});

// ────────────────────────────────────────────────────────────────────────────────
// Utility text agent — direct await returns the raw text value (no generator)
// ────────────────────────────────────────────────────────────────────────────────
test('utility text agent: await message() returns the text directly', async () => {
	const label = 'fake-utility-text';
	await Symposium.loadModel(new ScriptedModel(label, [{
		deltas: [],
		messages: [new Message('assistant', [{type: 'text', content: 'The answer is 42'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	agent.type = 'utility';
	await agent.init();

	const thread = await makeThread(agent, label);
	const value = await agent.message('what?', thread);
	assert.equal(value, 'The answer is 42');
});

// ────────────────────────────────────────────────────────────────────────────────
// Utility agent with response_schema, structured-output path: text content IS JSON
// ────────────────────────────────────────────────────────────────────────────────
test('utility agent with response_schema (structured_output): await returns parsed object', async () => {
	const label = 'fake-utility-json-structured';
	class StructuredScriptedModel extends ScriptedModel {
		async getModels() {
			return new Map([[this.label, {name: this.label, tokens: 1000, tools: true, structured_output: true}]]);
		}
	}
	await Symposium.loadModel(new StructuredScriptedModel(label, [{
		deltas: [],
		messages: [new Message('assistant', [{type: 'text', content: '{"name":"John","email":"john@example.com"}'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	agent.type = 'utility';
	agent.response_schema = {
		type: 'object',
		properties: {
			name: {type: 'string'},
			email: {type: 'string'},
		},
		required: ['name', 'email'],
	};
	await agent.init();

	const thread = await makeThread(agent, label);
	const value = await agent.message('My name is John, email john@example.com', thread);
	assert.deepEqual(value, {name: 'John', email: 'john@example.com'});
});

// ────────────────────────────────────────────────────────────────────────────────
// Utility agent with response_schema, function-call fallback (no structured_output)
// ────────────────────────────────────────────────────────────────────────────────
test('utility agent with response_schema (function-call fallback): await returns parsed args', async () => {
	const label = 'fake-utility-json-funccall';
	await Symposium.loadModel(new ScriptedModel(label, [{
		deltas: [],
		messages: [new Message('assistant', [
			{type: 'tool_call', content: [{id: 'call_r', name: 'response', arguments: {name: 'Jane', email: 'jane@example.com'}}]},
		])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	agent.type = 'utility';
	agent.response_schema = {
		type: 'object',
		properties: {
			name: {type: 'string'},
			email: {type: 'string'},
		},
		required: ['name', 'email'],
	};
	await agent.init();

	const thread = await makeThread(agent, label);
	const value = await agent.message('Extract Jane jane@example.com', thread);
	assert.deepEqual(value, {name: 'Jane', email: 'jane@example.com'});
});

// ────────────────────────────────────────────────────────────────────────────────
// Chat agent with response_schema: events stream, final {type:'result', value}
// ────────────────────────────────────────────────────────────────────────────────
test('chat agent with response_schema yields normal events plus final result event', async () => {
	const label = 'fake-chat-schema';
	class StructuredScriptedModel extends ScriptedModel {
		async getModels() {
			return new Map([[this.label, {name: this.label, tokens: 1000, tools: true, structured_output: true}]]);
		}
	}
	await Symposium.loadModel(new StructuredScriptedModel(label, [{
		deltas: [{type: 'text_delta', content: '{"city":"Rome"}'}],
		messages: [new Message('assistant', [{type: 'text', content: '{"city":"Rome"}'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	agent.response_schema = {
		type: 'object',
		properties: {city: {type: 'string'}},
		required: ['city'],
	};
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	for await (const ev of agent.message('Where?', thread))
		events.push(ev);

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'chunk', 'result', 'end']);
	assert.deepEqual(events[2].value, {city: 'Rome'});
});

// ────────────────────────────────────────────────────────────────────────────────
// response_schema + toolkit: the model may call its real tools across turns and then
// deliver the structured answer through the synthetic `response` tool. Verifies the
// two are NOT mutually exclusive (regression guard for the schema-vs-tools fix).
// ────────────────────────────────────────────────────────────────────────────────
test('chat agent with response_schema + toolkit: runs a tool then `response` yields the result', async () => {
	const label = 'fake-chat-schema-tools';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [],
			messages: [new Message('assistant', [
				{type: 'tool_call', content: [{id: 'call_s', name: 'search', arguments: {q: 'Rome'}}]},
			])],
		},
		{
			deltas: [],
			messages: [new Message('assistant', [
				{type: 'tool_call', content: [{id: 'call_r', name: 'response', arguments: {unique_code: 'IT-05-087', confidence: 0.9}}]},
			])],
		},
	]));

	let searched = null;
	class SearchTool extends Toolkit {
		name = 'search';
		async getTools() {
			return [{name: 'search', description: 'search the master tree', parameters: {type: 'object', properties: {q: {type: 'string'}}}}];
		}
		async callTool(_thread, _name, payload) {
			searched = payload.q;
			return {results: [{unique_code: 'IT-05-087'}]};
		}
	}

	const agent = new Agent();
	agent.default_model = label;
	agent.response_schema = {
		type: 'object',
		properties: {unique_code: {type: 'string'}, confidence: {type: 'number'}},
		required: ['unique_code', 'confidence'],
	};
	await agent.addToolkit(new SearchTool());
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	for await (const ev of agent.message('match Rome', thread))
		events.push(ev);

	const types = events.map(e => e.type);
	// the real `search` tool ran (tool + tool_response), THEN `response` carried the answer
	assert.deepEqual(types, ['start', 'tool', 'tool_response', 'result', 'end']);
	assert.equal(searched, 'Rome');
	assert.equal(events[1].name, 'search');
	assert.deepEqual(events.find(e => e.type === 'result').value, {unique_code: 'IT-05-087', confidence: 0.9});
});

// ────────────────────────────────────────────────────────────────────────────────
// parseOptions: append_tools augments the toolkit tools rather than replacing them,
// so the synthetic `response` tool coexists with the real ones.
// ────────────────────────────────────────────────────────────────────────────────
test('Model.parseOptions merges append_tools alongside the toolkit tools', () => {
	const model = new Model();
	const toolkitTools = [{name: 'search'}, {name: 'get_chain'}];

	const {tools} = model.parseOptions({append_tools: [{name: 'response'}]}, toolkitTools);
	assert.deepEqual(tools.map(t => t.name), ['search', 'get_chain', 'response']);

	// force_tool validation still sees the appended tool
	const {tools: forced} = model.parseOptions({append_tools: [{name: 'response'}], force_tool: 'response'}, toolkitTools);
	assert.ok(forced.find(t => t.name === 'response'));
});

// ────────────────────────────────────────────────────────────────────────────────
// Tool authorization: tool.authorize() returns false, generator suspends until an
// {type:'auth'} control message arrives on the input channel.
// ────────────────────────────────────────────────────────────────────────────────
test('tools_auth suspends until {type:"auth", decision:"approve"} resumes the run', async () => {
	const label = 'fake-chat-auth';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [],
			messages: [new Message('assistant', [
				{type: 'tool_call', content: [{id: 'call_a', name: 'sensitive', arguments: {x: 1}}]},
			])],
		},
		{
			deltas: [{type: 'text_delta', content: 'Approved'}],
			messages: [new Message('assistant', [{type: 'text', content: 'Approved'}])],
		},
	]));

	class SensitiveTool extends Toolkit {
		name = 'sensitive';
		async getTools() {
			return [{name: 'sensitive', description: 'guarded', parameters: {type: 'object', properties: {x: {type: 'number'}}}}];
		}
		async authorize() { return false; }
		async callTool() { return {ok: true}; }
	}

	const agent = new Agent();
	agent.default_model = label;
	await agent.addToolkit(new SensitiveTool());
	await agent.init();

	const thread = await makeThread(agent, label);

	const input = createInputChannel();
	input.send('do the thing');

	const events = [];
	for await (const ev of agent.message(input, thread)) {
		events.push(ev);
		if (ev.type === 'tools_auth')
			input.send({type: 'auth', id: ev.id, decision: 'approve'});
		if (ev.type === 'output')
			input.close();
	}

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'tools_auth', 'tool', 'tool_response', 'chunk', 'output', 'end']);
	assert.ok(events[1].id);
	assert.equal(events[1].tools[0].name, 'sensitive');
});

// ────────────────────────────────────────────────────────────────────────────────
// Tool authorization: reject ends the run without invoking the tool.
// ────────────────────────────────────────────────────────────────────────────────
test('{type:"auth", decision:"reject"} drops the tool call and ends the run', async () => {
	const label = 'fake-chat-auth-reject';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [],
			messages: [new Message('assistant', [
				{type: 'tool_call', content: [{id: 'call_b', name: 'guarded', arguments: {}}]},
			])],
		},
	]));

	class GuardedTool extends Toolkit {
		name = 'guarded';
		called = 0;
		async getTools() {
			return [{name: 'guarded', description: 'guarded', parameters: {type: 'object', properties: {}}}];
		}
		async authorize() { return false; }
		async callTool() { this.called++; return {nope: true}; }
	}

	const guarded = new GuardedTool();
	const agent = new Agent();
	agent.default_model = label;
	await agent.addToolkit(guarded);
	await agent.init();

	const thread = await makeThread(agent, label);

	const input = createInputChannel();
	input.send('attempt');

	const events = [];
	for await (const ev of agent.message(input, thread)) {
		events.push(ev);
		if (ev.type === 'tools_auth') {
			input.send({type: 'auth', id: ev.id, decision: 'reject'});
			input.close();
		}
	}

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'tools_auth', 'end']);
	assert.equal(guarded.called, 0);
});

// ────────────────────────────────────────────────────────────────────────────────
// Tool authorization: closing the input channel without an auth response is
// treated as reject + cancel — the tool never runs and the loop ends.
// ────────────────────────────────────────────────────────────────────────────────
test('input channel closing without auth response rejects and cancels', async () => {
	const label = 'fake-chat-auth-close';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [],
			messages: [new Message('assistant', [
				{type: 'tool_call', content: [{id: 'call_c', name: 'unguarded_close', arguments: {}}]},
			])],
		},
	]));

	class CloseTool extends Toolkit {
		name = 'unguarded_close';
		called = 0;
		async getTools() {
			return [{name: 'unguarded_close', description: 'guarded', parameters: {type: 'object', properties: {}}}];
		}
		async authorize() { return false; }
		async callTool() { this.called++; return {nope: true}; }
	}

	const tool = new CloseTool();
	const agent = new Agent();
	agent.default_model = label;
	await agent.addToolkit(tool);
	await agent.init();

	const thread = await makeThread(agent, label);

	const input = createInputChannel();
	input.send('attempt');

	const events = [];
	for await (const ev of agent.message(input, thread)) {
		events.push(ev);
		if (ev.type === 'tools_auth')
			input.close();
	}

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'tools_auth', 'end']);
	assert.equal(tool.called, 0);
});

// ────────────────────────────────────────────────────────────────────────────────
// Phase 3 — Streaming input
// ────────────────────────────────────────────────────────────────────────────────

test('streaming input — channel.send(string) + close() runs one turn like a plain string', async () => {
	const label = 'fake-stream-basic';
	await Symposium.loadModel(new ScriptedModel(label, [{
		deltas: [{type: 'text_delta', content: 'Hi'}],
		messages: [new Message('assistant', [{type: 'text', content: 'Hi'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const input = createInputChannel();
	input.send('Hello');
	input.close();

	const events = [];
	for await (const ev of agent.message(input, thread))
		events.push(ev);

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'chunk', 'output', 'end']);
	assert.equal(events[1].content, 'Hi');
});

test('streaming input — second message after first turn triggers another turn', async () => {
	const label = 'fake-stream-second-turn';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [{type: 'text_delta', content: 'First'}],
			messages: [new Message('assistant', [{type: 'text', content: 'First'}])],
		},
		{
			deltas: [{type: 'text_delta', content: 'Second'}],
			messages: [new Message('assistant', [{type: 'text', content: 'Second'}])],
		},
	]));

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const input = createInputChannel();
	input.send('first');

	const events = [];
	const gen = agent.message(input, thread);

	let firstOutputSeen = false;
	let step = await gen.next();
	while (!step.done) {
		events.push(step.value);
		if (step.value.type === 'output' && !firstOutputSeen) {
			firstOutputSeen = true;
			queueMicrotask(() => {
				input.send('second');
				queueMicrotask(() => input.close());
			});
		}
		step = await gen.next();
	}

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'chunk', 'output', 'chunk', 'output', 'end']);
	const outputs = events.filter(e => e.type === 'output').map(e => e.content.content);
	assert.deepEqual(outputs, ['First', 'Second']);
});

test('streaming input — submit terminates initial buildup, concatenates pieces', async () => {
	const label = 'fake-stream-submit';
	let observedUserContent = null;

	class CapturingModel extends ScriptedModel {
		async *generate(_model, thread, _functions, _options) {
			for (let m of thread.messages) {
				if (m.role === 'user')
					observedUserContent = m.content;
			}
			const turn = this.script[this.calls++];
			for (const delta of turn.deltas || [])
				yield delta;
			return turn.messages;
		}
	}

	await Symposium.loadModel(new CapturingModel(label, [{
		deltas: [{type: 'text_delta', content: 'Ok'}],
		messages: [new Message('assistant', [{type: 'text', content: 'Ok'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const input = createInputChannel();
	input.send('part one');
	input.send('part two');
	input.send({type: 'submit'});
	input.close();

	const events = [];
	for await (const ev of agent.message(input, thread))
		events.push(ev);

	assert.ok(observedUserContent, 'user message should reach the model');
	assert.equal(observedUserContent.length, 2);
	assert.equal(observedUserContent[0].content, 'part one');
	assert.equal(observedUserContent[1].content, 'part two');
});

test('streaming input — cancel ends the loop gracefully without starting another turn', async () => {
	const label = 'fake-stream-cancel';
	const model = new ScriptedModel(label, [
		{
			deltas: [{type: 'text_delta', content: 'A'}],
			messages: [new Message('assistant', [{type: 'text', content: 'A'}])],
		},
	]);
	await Symposium.loadModel(model);

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const input = createInputChannel();
	input.send('go');

	const events = [];
	const gen = agent.message(input, thread);

	let step = await gen.next();
	while (!step.done) {
		events.push(step.value);
		if (step.value.type === 'output')
			queueMicrotask(() => input.send({type: 'cancel'}));
		step = await gen.next();
	}

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'chunk', 'output', 'end']);
	assert.equal(model.calls, 1);
});

test('plain ContentBlock[] input continues to work', async () => {
	const label = 'fake-array-input';
	await Symposium.loadModel(new ScriptedModel(label, [{
		deltas: [{type: 'text_delta', content: 'X'}],
		messages: [new Message('assistant', [{type: 'text', content: 'X'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	for await (const ev of agent.message([{type: 'text', content: 'hi'}], thread))
		events.push(ev);

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'chunk', 'output', 'end']);
});

// ────────────────────────────────────────────────────────────────────────────────
// Phase 5 — Hybrid retry: silent retry when no chunk has been yielded yet.
// ────────────────────────────────────────────────────────────────────────────────
test('retry is silent when error occurs before any chunk is yielded', async () => {
	const label = 'fake-retry-silent';
	const boom = Object.assign(new Error('boom'), {response: {status: 500, data: 'x'}});
	await Symposium.loadModel(new ScriptedModel(label, [
		{throwBefore: boom},
		{
			deltas: [{type: 'text_delta', content: 'ok'}],
			messages: [new Message('assistant', [{type: 'text', content: 'ok'}])],
		},
	]));

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	for await (const ev of agent.message('hi', thread))
		events.push(ev);

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'chunk', 'output', 'end']);
	assert.equal(events.find(e => e.type === 'retry'), undefined);
});

// ────────────────────────────────────────────────────────────────────────────────
// Phase 5 — Hybrid retry: visible retry when at least one chunk has been yielded.
// ────────────────────────────────────────────────────────────────────────────────
test('retry event is yielded when error occurs after a chunk', async () => {
	const label = 'fake-retry-visible';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [{type: 'text_delta', content: 'partial', _thenThrow: new Error('mid-stream blew up')}],
			messages: [],
		},
		{
			deltas: [{type: 'text_delta', content: 'done'}],
			messages: [new Message('assistant', [{type: 'text', content: 'done'}])],
		},
	]));

	const agent = new Agent();
	agent.default_model = label;
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	for await (const ev of agent.message('hi', thread))
		events.push(ev);

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'chunk', 'retry', 'chunk', 'output', 'end']);
	const retryEv = events.find(e => e.type === 'retry');
	assert.equal(retryEv.attempt, 1);
	assert.equal(retryEv.reason, 'mid-stream blew up');
});

// ────────────────────────────────────────────────────────────────────────────────
// Phase 5 — Hybrid retry: exhausted retries surface the error out of the generator.
// ────────────────────────────────────────────────────────────────────────────────
test('exhausted retries throw out of the generator', async () => {
	const label = 'fake-retry-exhausted';
	await Symposium.loadModel(new ScriptedModel(label, [
		{throwBefore: new Error('fail-1')},
		{throwBefore: new Error('fail-2')},
		{throwBefore: new Error('fail-3')},
	]));

	const agent = new Agent();
	agent.default_model = label;
	agent.max_retries = 2;
	await agent.init();

	const thread = await makeThread(agent, label);

	await assert.rejects(
		(async () => {
			for await (const _ev of agent.message('hi', thread)) { /* drain */ }
		})(),
		/fail-3/,
	);
});
