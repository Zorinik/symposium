import {test} from 'node:test';
import assert from 'node:assert/strict';

import OllamaModel from '../../Models/OllamaModel.js';
import Message from '../../Message.js';
import {asyncIterable, fakeThread, drain} from '../helpers/mockSdk.js';

function buildModelDef() {
	return {
		name: 'llama3',
		tools: true,
		structured_output: true,
	};
}

function installFakeOllama(modelInstance, chunks) {
	modelInstance.getOllama = () => ({
		async chat(_payload) {
			return asyncIterable(chunks);
		},
		async list() {
			return {models: []};
		},
	});
}

test('OllamaModel streams text + thinking chunks and assembles a Message[]', async () => {
	const m = new OllamaModel();
	installFakeOllama(m, [
		{message: {thinking: 'reasoning '}},
		{message: {thinking: 'step'}},
		{message: {content: 'Hello'}},
		{message: {content: ' world'}, done: true},
	]);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'reasoning_delta', content: 'reasoning '},
		{type: 'reasoning_delta', content: 'step'},
		{type: 'text_delta', content: 'Hello'},
		{type: 'text_delta', content: ' world'},
	]);

	assert.equal(value.length, 1);
	assert.ok(value[0] instanceof Message);
	assert.deepEqual(value[0].content, [
		{type: 'reasoning', content: 'reasoning step'},
		{type: 'text', content: 'Hello world'},
	]);
});

test('OllamaModel yields tool_call from final chunk', async () => {
	const m = new OllamaModel();
	installFakeOllama(m, [
		{
			message: {
				tool_calls: [{function: {name: 'do_thing', arguments: {a: 1}}}],
			},
			done: true,
		},
	]);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'tool_call', content: {name: 'do_thing', arguments: {a: 1}}},
	]);

	assert.deepEqual(value[0].content, [
		{
			type: 'function',
			content: [{name: 'do_thing', arguments: {a: 1}}],
		},
	]);
});

test('OllamaModel emulates streaming when only a single full chunk arrives', async () => {
	const m = new OllamaModel();
	installFakeOllama(m, [
		{message: {content: 'One shot response'}, done: true},
	]);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'text_delta', content: 'One shot response'},
	]);
	assert.deepEqual(value[0].content, [{type: 'text', content: 'One shot response'}]);
});
