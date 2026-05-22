import {test} from 'node:test';
import assert from 'node:assert/strict';

import Agent from '../Agent.js';
import Symposium from '../Symposium.js';
import Model from '../Model.js';
import Message from '../Message.js';
import Thread from '../Thread.js';
import Tool from '../Tool.js';

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
		for (const delta of turn.deltas || [])
			yield delta;
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
				{type: 'function', content: [{id: 'call_1', name: 'echo', arguments: {msg: 'hi'}}]},
			])],
		},
		{
			deltas: [{type: 'text_delta', content: 'Done'}],
			messages: [new Message('assistant', [{type: 'text', content: 'Done'}])],
		},
	]));

	class EchoTool extends Tool {
		name = 'echo';
		async getFunctions() {
			return [{name: 'echo', description: 'echoes', parameters: {type: 'object', properties: {msg: {type: 'string'}}}}];
		}
		async callFunction(_thread, _name, payload) {
			return {echoed: payload.msg};
		}
	}

	const agent = new Agent();
	agent.default_model = label;
	await agent.addTool(new EchoTool());
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
// Utility text agent
// ────────────────────────────────────────────────────────────────────────────────
test('utility text agent yields start → result → end with the parsed value', async () => {
	const label = 'fake-utility-text';
	await Symposium.loadModel(new ScriptedModel(label, [{
		deltas: [],
		messages: [new Message('assistant', [{type: 'text', content: 'The answer is 42'}])],
	}]));

	const agent = new Agent();
	agent.default_model = label;
	agent.type = 'utility';
	agent.utility = {type: 'text'};
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	for await (const ev of agent.message('what?', thread))
		events.push(ev);

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'result', 'end']);
	assert.equal(events[1].value, 'The answer is 42');
});

// ────────────────────────────────────────────────────────────────────────────────
// Tool authorization: tool.authorize() returns false, generator suspends until
// confirmFunctions() is called from outside.
// ────────────────────────────────────────────────────────────────────────────────
test('tools_auth suspends until confirmFunctions(id, "approve") resumes the run', async () => {
	const label = 'fake-chat-auth';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [],
			messages: [new Message('assistant', [
				{type: 'function', content: [{id: 'call_a', name: 'sensitive', arguments: {x: 1}}]},
			])],
		},
		{
			deltas: [{type: 'text_delta', content: 'Approved'}],
			messages: [new Message('assistant', [{type: 'text', content: 'Approved'}])],
		},
	]));

	class SensitiveTool extends Tool {
		name = 'sensitive';
		async getFunctions() {
			return [{name: 'sensitive', description: 'guarded', parameters: {type: 'object', properties: {x: {type: 'number'}}}}];
		}
		async authorize() { return false; }
		async callFunction() { return {ok: true}; }
	}

	const agent = new Agent();
	agent.default_model = label;
	await agent.addTool(new SensitiveTool());
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	const gen = agent.message('do the thing', thread);

	// Iterate until we see tools_auth, then resolve it from outside.
	let result = await gen.next();
	while (!result.done) {
		events.push(result.value);
		if (result.value.type === 'tools_auth') {
			// Schedule the approval on the next microtask so the generator is suspended on the pending promise.
			queueMicrotask(() => agent.confirmFunctions(result.value.id, 'approve'));
		}
		result = await gen.next();
	}

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'tools_auth', 'tool', 'tool_response', 'chunk', 'output', 'end']);
	assert.ok(events[1].id);
	assert.equal(events[1].functions[0].name, 'sensitive');
});

// ────────────────────────────────────────────────────────────────────────────────
// Tool authorization: reject ends the run without invoking the tool.
// ────────────────────────────────────────────────────────────────────────────────
test('confirmFunctions(id, "reject") drops the tool call and ends the run', async () => {
	const label = 'fake-chat-auth-reject';
	await Symposium.loadModel(new ScriptedModel(label, [
		{
			deltas: [],
			messages: [new Message('assistant', [
				{type: 'function', content: [{id: 'call_b', name: 'guarded', arguments: {}}]},
			])],
		},
	]));

	class GuardedTool extends Tool {
		name = 'guarded';
		called = 0;
		async getFunctions() {
			return [{name: 'guarded', description: 'guarded', parameters: {type: 'object', properties: {}}}];
		}
		async authorize() { return false; }
		async callFunction() { this.called++; return {nope: true}; }
	}

	const guarded = new GuardedTool();
	const agent = new Agent();
	agent.default_model = label;
	await agent.addTool(guarded);
	await agent.init();

	const thread = await makeThread(agent, label);

	const events = [];
	const gen = agent.message('attempt', thread);
	let result = await gen.next();
	while (!result.done) {
		events.push(result.value);
		if (result.value.type === 'tools_auth')
			queueMicrotask(() => agent.confirmFunctions(result.value.id, 'reject'));
		result = await gen.next();
	}

	const types = events.map(e => e.type);
	assert.deepEqual(types, ['start', 'tools_auth', 'end']);
	assert.equal(guarded.called, 0);
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
