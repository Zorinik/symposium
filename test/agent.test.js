import {test} from 'node:test';
import assert from 'node:assert/strict';

import Agent from '../Agent.js';
import Symposium from '../Symposium.js';
import Model from '../Model.js';
import Message from '../Message.js';
import Thread from '../Thread.js';

class FakeModel extends Model {
	async getModels() {
		return new Map([
			['fake', {
				name: 'fake',
				tokens: 1000,
				tools: true,
				structured_output: false,
			}],
		]);
	}

	async *generate(_model, _thread, _functions, _options) {
		yield {type: 'text_delta', content: 'Hello'};
		yield {type: 'text_delta', content: ' world'};
		return [new Message('assistant', [{type: 'text', content: 'Hello world'}])];
	}
}

test('Agent.generateCompletion drains the streaming generator and returns Message[]', async () => {
	await Symposium.loadModel(new FakeModel());

	const agent = new Agent();
	agent.default_model = 'fake';
	await agent.init();

	const thread = new Thread('test-thread', agent);
	thread.state = {model: 'fake'};

	const messages = await agent.generateCompletion(thread);

	assert.equal(messages.length, 1);
	assert.ok(messages[0] instanceof Message);
	assert.equal(messages[0].role, 'assistant');
	assert.deepEqual(messages[0].content, [{type: 'text', content: 'Hello world'}]);
});
