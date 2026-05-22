import {test} from 'node:test';
import assert from 'node:assert/strict';

import OpenAIModel from '../../Models/OpenAIModel.js';
import Message from '../../Message.js';
import {openAiResponsesStream, fakeThread, drain} from '../helpers/mockSdk.js';

function buildModelDef(overrides = {}) {
	return {
		name: 'gpt-5',
		tokens: 400000,
		tools: true,
		structured_output: true,
		...overrides,
	};
}

function installFakeOpenAi(modelInstance, stream) {
	modelInstance.getOpenAi = () => ({
		responses: {
			stream() {
				return stream;
			},
		},
	});
}

test('OpenAIModel streams text deltas and returns a text Message[]', async () => {
	const m = new OpenAIModel();
	const stream = openAiResponsesStream(
		[
			{type: 'response.output_text.delta', delta: 'Hello'},
			{type: 'response.output_text.delta', delta: ' world'},
		],
		{
			output: [
				{
					type: 'message',
					content: [{text: 'Hello world'}],
				},
			],
		},
	);
	installFakeOpenAi(m, stream);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'text_delta', content: 'Hello'},
		{type: 'text_delta', content: ' world'},
	]);

	assert.equal(value.length, 1);
	assert.ok(value[0] instanceof Message);
	assert.equal(value[0].role, 'assistant');
	assert.deepEqual(value[0].content, [{type: 'text', content: 'Hello world'}]);
});

test('OpenAIModel yields tool_call on output_item.done and assembles a function block', async () => {
	const m = new OpenAIModel();
	const stream = openAiResponsesStream(
		[
			{
				type: 'response.output_item.done',
				item: {
					type: 'function_call',
					call_id: 'call_abc',
					name: 'do_thing',
					arguments: '{"a":1}',
				},
			},
		],
		{
			output: [
				{
					type: 'function_call',
					call_id: 'call_abc',
					name: 'do_thing',
					arguments: '{"a":1}',
				},
			],
		},
	);
	installFakeOpenAi(m, stream);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{
			type: 'tool_call',
			content: {id: 'call_abc', name: 'do_thing', arguments: {a: 1}},
		},
	]);

	assert.deepEqual(value[0].content, [
		{
			type: 'function',
			content: [{id: 'call_abc', name: 'do_thing', arguments: {a: 1}}],
		},
	]);
});

test('OpenAIModel emits reasoning_delta and final reasoning block', async () => {
	const m = new OpenAIModel();
	const reasoningOutput = {
		type: 'reasoning',
		summary: [{text: 'thinking step'}],
	};
	const stream = openAiResponsesStream(
		[
			{type: 'response.reasoning_summary_text.delta', delta: 'thinking '},
			{type: 'response.reasoning_summary_text.delta', delta: 'step'},
			{type: 'response.output_text.delta', delta: 'done'},
		],
		{
			output: [
				reasoningOutput,
				{type: 'message', content: [{text: 'done'}]},
			],
		},
	);
	installFakeOpenAi(m, stream);

	const {deltas, value} = await drain(m.generate(buildModelDef(), fakeThread()));

	assert.deepEqual(deltas, [
		{type: 'reasoning_delta', content: 'thinking '},
		{type: 'reasoning_delta', content: 'step'},
		{type: 'text_delta', content: 'done'},
	]);

	assert.equal(value[0].content.length, 2);
	assert.deepEqual(value[0].content[0], {
		type: 'reasoning',
		content: 'thinking step',
		original: reasoningOutput,
	});
	assert.deepEqual(value[0].content[1], {type: 'text', content: 'done'});
});

test('OpenAIModel emits image delta and final image block', async () => {
	const m = new OpenAIModel();
	const imageItem = {
		type: 'image_generation_call',
		id: 'img_1',
		status: 'completed',
		output_format: 'png',
		result: 'BASE64DATA',
		revised_prompt: 'cute cat',
		size: '1024x1024',
	};
	const stream = openAiResponsesStream(
		[{type: 'response.output_item.done', item: imageItem}],
		{output: [imageItem]},
	);
	installFakeOpenAi(m, stream);

	const {deltas, value} = await drain(m.generate(buildModelDef({image_generation: true}), fakeThread(), [], {image_generation: true}));

	assert.equal(deltas.length, 1);
	assert.equal(deltas[0].type, 'image');
	assert.equal(deltas[0].content.mime, 'image/png');
	assert.equal(deltas[0].content.data, 'BASE64DATA');
	assert.equal(deltas[0].meta.id, 'img_1');

	assert.equal(value[0].content[0].type, 'image');
	assert.equal(value[0].content[0].meta.prompt, 'cute cat');
});
