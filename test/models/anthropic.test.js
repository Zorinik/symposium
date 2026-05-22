import {test} from 'node:test';
import assert from 'node:assert/strict';

import AnthropicModel from '../../Models/AnthropicModel.js';
import Message from '../../Message.js';
import {anthropicMessagesStream, fakeThread, drain} from '../helpers/mockSdk.js';

function buildModelDef(overrides = {}) {
	return {
		name: 'claude-haiku-4-5-20251001',
		tokens: 200000,
		tools: true,
		...overrides,
	};
}

function installFakeAnthropic(modelInstance, stream) {
	modelInstance.getAnthropic = () => ({
		beta: {
			messages: {
				stream() {
					return stream;
				},
			},
		},
	});
}

test('AnthropicModel streams text deltas and assembles a text Message[]', async () => {
	const m = new AnthropicModel();
	const finalMessage = {
		content: [{type: 'text', text: 'Hello world'}],
	};
	const stream = anthropicMessagesStream(
		[
			{type: 'content_block_start', index: 0, content_block: {type: 'text'}},
			{type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Hello'}},
			{type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: ' world'}},
			{type: 'content_block_stop', index: 0},
		],
		finalMessage,
	);
	installFakeAnthropic(m, stream);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'text_delta', content: 'Hello'},
		{type: 'text_delta', content: ' world'},
	]);

	assert.equal(value.length, 1);
	assert.ok(value[0] instanceof Message);
	assert.deepEqual(value[0].content, [{type: 'text', content: 'Hello world'}]);
});

test('AnthropicModel buffers input_json_delta and yields a complete tool_call', async () => {
	const m = new AnthropicModel();
	const finalMessage = {
		content: [
			{
				type: 'tool_use',
				id: 'tool_1',
				name: 'do_thing',
				input: {a: 1, b: 'x'},
			},
		],
	};
	const stream = anthropicMessagesStream(
		[
			{
				type: 'content_block_start',
				index: 0,
				content_block: {type: 'tool_use', id: 'tool_1', name: 'do_thing'},
			},
			{type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{"a":1,'}},
			{type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '"b":"x"}'}},
			{type: 'content_block_stop', index: 0},
		],
		finalMessage,
	);
	installFakeAnthropic(m, stream);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{
			type: 'tool_call',
			content: {id: 'tool_1', name: 'do_thing', arguments: {a: 1, b: 'x'}},
		},
	]);

	assert.deepEqual(value[0].content, [
		{
			type: 'function',
			content: [{id: 'tool_1', name: 'do_thing', arguments: {a: 1, b: 'x'}}],
		},
	]);
});

test('AnthropicModel emits reasoning_delta from thinking_delta', async () => {
	const m = new AnthropicModel();
	const thinkingBlock = {type: 'thinking', thinking: 'reasoning text'};
	const finalMessage = {
		content: [thinkingBlock, {type: 'text', text: 'done'}],
	};
	const stream = anthropicMessagesStream(
		[
			{type: 'content_block_start', index: 0, content_block: {type: 'thinking'}},
			{type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'reasoning '}},
			{type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'text'}},
			{type: 'content_block_stop', index: 0},
			{type: 'content_block_start', index: 1, content_block: {type: 'text'}},
			{type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text: 'done'}},
			{type: 'content_block_stop', index: 1},
		],
		finalMessage,
	);
	installFakeAnthropic(m, stream);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'reasoning_delta', content: 'reasoning '},
		{type: 'reasoning_delta', content: 'text'},
		{type: 'text_delta', content: 'done'},
	]);

	assert.deepEqual(value[0].content[0], {
		type: 'reasoning',
		content: 'reasoning text',
		original: thinkingBlock,
	});
	assert.deepEqual(value[0].content[1], {type: 'text', content: 'done'});
});
