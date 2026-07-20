import {test} from 'node:test';
import assert from 'node:assert/strict';

import GroqModel from '../../Models/GroqModel.js';
import Message from '../../Message.js';
import {asyncIterable, fakeThread, drain} from '../helpers/mockSdk.js';

function buildModelDef() {
	return {
		name: 'llama-3.3-70b-versatile',
		tokens: 128000,
		tools: true,
	};
}

function installFakeGroq(modelInstance, chunks) {
	modelInstance.getGroq = () => ({
		chat: {
			completions: {
				async create(_payload) {
					return asyncIterable(chunks);
				},
			},
		},
	});
}

test('GroqModel streams text chunks and assembles a text Message[]', async () => {
	const m = new GroqModel();
	installFakeGroq(m, [
		{choices: [{delta: {content: 'Hi'}}]},
		{choices: [{delta: {content: ' there'}}]},
		{choices: [{delta: {}, finish_reason: 'stop'}]},
	]);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'text_delta', content: 'Hi'},
		{type: 'text_delta', content: ' there'},
	]);

	assert.equal(value.length, 1);
	assert.ok(value[0] instanceof Message);
	assert.deepEqual(value[0].content, [{type: 'text', content: 'Hi there'}]);
});

test('GroqModel accumulates tool_call deltas across chunks', async () => {
	const m = new GroqModel();
	installFakeGroq(m, [
		{choices: [{delta: {tool_calls: [{index: 0, id: 'c1', type: 'function', function: {name: 'sum', arguments: '{"x":'}}]}}]},
		{choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '5}'}}]}}]},
		{choices: [{delta: {}, finish_reason: 'tool_calls'}]},
	]);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{
			type: 'tool_call',
			content: {id: 'c1', name: 'sum', arguments: {x: 5}},
		},
	]);

	assert.deepEqual(value[0].content, [
		{
			type: 'tool_call',
			content: [{id: 'c1', name: 'sum', arguments: {x: 5}}],
		},
	]);
});

test('GroqModel yields a normalized usage delta from the x_groq final chunk', async () => {
	const m = new GroqModel();
	installFakeGroq(m, [
		{choices: [{delta: {content: 'Hi'}}]},
		{choices: [{delta: {}, finish_reason: 'stop'}], x_groq: {usage: {prompt_tokens: 80, completion_tokens: 20}}},
	]);

	const {deltas} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas[deltas.length - 1], {
		type: 'usage',
		content: {input: 80, output: 20, cached: 0, context: 100},
	});
});
