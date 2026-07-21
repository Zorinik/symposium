import {test} from 'node:test';
import assert from 'node:assert/strict';

import Agent from '../Agent.js';
import Symposium from '../Symposium.js';
import Model from '../Model.js';
import Message from '../Message.js';
import Thread from '../Thread.js';
import ContextHandler from '../ContextHandler.js';
import Scrubber from '../Scrubber.js';

import {createInputChannel} from '../InputChannel.js';

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
		return turn.messages;
	}
}

function imageBlock(path = undefined) {
	return {type: 'image', content: {type: 'base64', mime: 'image/png', data: 'AAAA', path}};
}

function makeScrubbableThread() {
	const thread = new Thread('scrub-test', {name: 'TestAgent'});
	thread.addMessage('system', 'You are a test agent');
	thread.addMessage('user', [{type: 'text', content: 'look at this'}, imageBlock()]);
	thread.addMessage('assistant', 'I see a cat');
	thread.addMessage('user', 'second message');
	thread.addMessage('assistant', 'ok');
	thread.addMessage('user', 'third message');
	thread.addMessage('assistant', 'ok');
	thread.addMessage('user', 'fourth message');
	return thread;
}

test('Scrubber replaces old image blocks with a stub, keeps recent turns intact', async () => {
	const thread = makeScrubbableThread();
	const scrubber = new Scrubber({keep_last: 3});

	await scrubber.handle(thread);

	const first_user = thread.messages[1];
	assert.equal(first_user.content[0].content, 'look at this');
	assert.equal(first_user.content[1].type, 'text');
	assert.match(first_user.content[1].content, /image removed from context/);
	// Recent messages untouched
	assert.equal(thread.messages[7].content[0].content, 'fourth message');
});

test('Scrubber leaves images inside the protected window alone', async () => {
	const thread = new Thread('scrub-window', {name: 'TestAgent'});
	thread.addMessage('user', [imageBlock()]);
	thread.addMessage('assistant', 'ok');
	thread.addMessage('user', 'follow-up');

	// Only 2 user messages, keep_last 3 → nothing is old enough
	await new Scrubber({keep_last: 3}).handle(thread);
	assert.equal(thread.messages[0].content[0].type, 'image');
});

test('Scrubber stub mentions the on-disk path when the block carries one', async () => {
	const thread = makeScrubbableThread();
	thread.messages[1].content[1] = imageBlock('/tmp/photo.png');

	await new Scrubber({keep_last: 3}).handle(thread);
	assert.match(thread.messages[1].content[1].content, /\/tmp\/photo\.png/);
});

test('Scrubber trims oversized user texts but not assistant ones', async () => {
	const long = 'x'.repeat(500);
	const thread = new Thread('scrub-text', {name: 'TestAgent'});
	thread.addMessage('user', long);
	thread.addMessage('assistant', long);
	thread.addMessage('user', 'a');
	thread.addMessage('user', 'b');
	thread.addMessage('user', 'c');

	await new Scrubber({keep_last: 3, max_text_length: 100, keep_chars: 10}).handle(thread);

	assert.match(thread.messages[0].content[0].content, /^x{10}\n\[\.\.\. 490 characters removed/);
	assert.equal(thread.messages[1].content[0].content, long);
});

test('Scrubber trims oversized tool results preserving name and id', async () => {
	const thread = new Thread('scrub-tool', {name: 'TestAgent'});
	thread.addMessage('tool', [{
		type: 'tool_result',
		content: {name: 'WebFetch', id: 'call_1', response: 'y'.repeat(500)},
	}], 'WebFetch');
	thread.addMessage('user', 'a');
	thread.addMessage('user', 'b');
	thread.addMessage('user', 'c');

	await new Scrubber({keep_last: 3, max_text_length: 100, keep_chars: 10}).handle(thread);

	const block = thread.messages[0].content[0];
	assert.equal(block.type, 'tool_result');
	assert.equal(block.content.name, 'WebFetch');
	assert.equal(block.content.id, 'call_1');
	assert.match(block.content.response, /characters removed from context/);
});

test('Scrubber never touches system messages and is idempotent', async () => {
	const long_system = 's'.repeat(500);
	const thread = new Thread('scrub-sys', {name: 'TestAgent'});
	thread.addMessage('system', long_system);
	thread.addMessage('user', [imageBlock()]);
	thread.addMessage('user', 'a');
	thread.addMessage('user', 'b');
	thread.addMessage('user', 'c');

	const scrubber = new Scrubber({keep_last: 3, max_text_length: 100, keep_chars: 10});
	await scrubber.handle(thread);
	assert.equal(thread.messages[0].content[0].content, long_system);

	const after_first = JSON.stringify(thread.messages);
	await scrubber.handle(thread);
	assert.equal(JSON.stringify(thread.messages), after_first);
});

// ────────────────────────────────────────────────────────────────────────────────
// Agent integration: the memory handler must run before EVERY LLM call in a
// streaming run, not just once at the start of execute().
// ────────────────────────────────────────────────────────────────────────────────
test('memory_handler runs per turn in a streaming run', async () => {
	const label = 'fake-scrub-streaming';
	await Symposium.loadModel(new ScriptedModel(label, [
		{messages: [new Message('assistant', [{type: 'text', content: 'first'}])]},
		{messages: [new Message('assistant', [{type: 'text', content: 'second'}])]},
	]));

	class CountingHandler extends ContextHandler {
		calls = 0;

		async handle(thread) {
			this.calls++;
			return thread;
		}
	}

	const handler = new CountingHandler();
	const agent = new Agent({memory_handler: handler});
	agent.default_model = label;
	await agent.init();

	const thread = new Thread('scrub-streaming', agent);
	thread.state = {model: label};

	const channel = createInputChannel();
	channel.send('first message');
	channel.send({type: 'submit'});

	let turns = 0;
	for await (const ev of agent.message(channel, thread)) {
		if (ev.type === 'turn_end') {
			turns++;
			if (turns === 1)
				channel.send('second message');
			else
				channel.close();
		}
	}

	assert.equal(turns, 2);
	assert.equal(handler.calls, 2);
});

test('a memory_handler returning a clone gets re-registered in agent.threads', async () => {
	const label = 'fake-scrub-clone';
	await Symposium.loadModel(new ScriptedModel(label, [
		{messages: [new Message('assistant', [{type: 'text', content: 'done'}])]},
	]));

	class CloningHandler extends ContextHandler {
		async handle(thread) {
			this.last_clone = thread.clone(true);
			return this.last_clone;
		}
	}

	const handler = new CloningHandler();
	const agent = new Agent({memory_handler: handler});
	agent.default_model = label;
	await agent.init();

	const thread = new Thread('scrub-clone', agent);
	thread.state = {model: label};

	for await (const ev of agent.trigger(thread)) {
		void ev;
	}

	assert.equal(agent.threads.get('scrub-clone'), handler.last_clone);
});
