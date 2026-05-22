import {test} from 'node:test';
import assert from 'node:assert/strict';

import LegacyOpenAIModel from '../../Models/LegacyOpenAIModel.js';
import Message from '../../Message.js';
import {asyncIterable, fakeThread, drain} from '../helpers/mockSdk.js';

function buildModelDef() {
	return {
		name: 'gpt-3.5-turbo',
		tokens: 16000,
		tools: true,
	};
}

function installFakeOpenAi(modelInstance, chunks) {
	modelInstance.getOpenAi = () => ({
		chat: {
			completions: {
				async create(_payload) {
					return asyncIterable(chunks);
				},
			},
		},
	});
}

test('LegacyOpenAIModel streams text chunks and assembles a text Message[]', async () => {
	const m = new LegacyOpenAIModel();
	installFakeOpenAi(m, [
		{choices: [{delta: {content: 'Hello'}}]},
		{choices: [{delta: {content: ' world'}}]},
		{choices: [{delta: {}, finish_reason: 'stop'}]},
	]);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'text_delta', content: 'Hello'},
		{type: 'text_delta', content: ' world'},
	]);

	assert.equal(value.length, 1);
	assert.ok(value[0] instanceof Message);
	assert.deepEqual(value[0].content, [{type: 'text', content: 'Hello world'}]);
});

test('LegacyOpenAIModel accumulates tool_call deltas across chunks and yields a complete tool_call', async () => {
	const m = new LegacyOpenAIModel();
	installFakeOpenAi(m, [
		{choices: [{delta: {tool_calls: [{index: 0, id: 'call_xyz', type: 'function', function: {name: 'do_thing', arguments: '{"a":'}}]}}]},
		{choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '1}'}}]}}]},
		{choices: [{delta: {}, finish_reason: 'tool_calls'}]},
	]);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{
			type: 'tool_call',
			content: {id: 'call_xyz', name: 'do_thing', arguments: {a: 1}},
		},
	]);

	assert.deepEqual(value[0].content, [
		{
			type: 'function',
			content: [{id: 'call_xyz', name: 'do_thing', arguments: {a: 1}}],
		},
	]);
});

test('LegacyOpenAIModel combines text + tool_calls in one Message', async () => {
	const m = new LegacyOpenAIModel();
	installFakeOpenAi(m, [
		{choices: [{delta: {content: 'Calling now'}}]},
		{choices: [{delta: {tool_calls: [{index: 0, id: 'c1', type: 'function', function: {name: 'f', arguments: '{}'}}]}}]},
		{choices: [{delta: {}, finish_reason: 'tool_calls'}]},
	]);

	const {value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.equal(value[0].content.length, 2);
	assert.deepEqual(value[0].content[0], {type: 'text', content: 'Calling now'});
	assert.equal(value[0].content[1].type, 'function');
	assert.equal(value[0].content[1].content[0].name, 'f');
});
