import Model from "../Model.js";
import OpenAI from "openai";
import Message from "../Message.js";
import {encoding_for_model} from "tiktoken";

export default class OpenAIModel extends Model {
	openai;

	async getModels() {
		return new Map([
			['gpt-4o', {
				name: 'gpt-4o',
				tiktoken: 'gpt-4',
				tokens: 128000,
				tools: true,
				structured_output: true,
			}],
			['gpt-5', {
				name: 'gpt-5',
				tiktoken: 'gpt-4',
				tokens: 400000,
				tools: true,
				structured_output: true,
				audio: true,
				image_generation: true,
			}],
			['gpt-5-mini', {
				name: 'gpt-5-mini',
				tiktoken: 'gpt-4',
				tokens: 400000,
				tools: true,
				structured_output: true,
			}],
		]);
	}

	getOpenAi() {
		if (!this.openai)
			this.openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

		return this.openai;
	}

	async generate(model, thread, functions = [], options = {}) {
		const parsed = this.parseOptions(options, functions);
		options = parsed.options;
		functions = parsed.functions;

		let messages = thread.messages;

		if (functions.length && !model.tools) {
			// Se il modello non supporta nativamente le funzioni, inserisco il prompt ad hoc come ultimo messaggio di sistema
			const functions_prompt = this.promptFromFunctions(options, functions);
			let system_messages = [], other_messages = [], first_found = false;
			for (let message of messages) {
				if (!first_found && message.role !== 'system')
					first_found = true;

				if (!first_found)
					system_messages.push(message);
				else
					other_messages.push(message);
			}

			system_messages.push(new Message('system', functions_prompt));

			messages = [...system_messages, ...other_messages];
			functions = [];
		}

		const convertedMessages = [];
		for (let m of messages)
			convertedMessages.push(...this.convertMessage(m, model));

		const tools = functions.map(f => ({
			type: 'function',
			...f,
		}));

		if (model.tools && model.image_generation && options.image_generation)
			tools.push({type: 'image_generation'});

		const completion_payload = {
			model: model.name,
			input: convertedMessages,
			store: false,
			include: ['reasoning.encrypted_content'],
			tools,
			reasoning: {
				summary: 'auto',
			},
		};

		if (options.force_function) {
			completion_payload.tool_choice = {
				type: 'function',
				name: options.force_function,
			};
		}

		if (options.response_format)
			completion_payload.text = {format: options.response_format};

		if (!completion_payload.tools.length)
			delete completion_payload.tools;

		const completion = await this.getOpenAi().responses.create(completion_payload);

		const message_content = [];
		for (let output of completion.output) {
			switch (output.type) {
				case 'message':
					let text = output.content.map(c => c.text).join('\n');
					message_content.push({type: 'text', content: text});
					break;

				case 'image_generation_call':
					const mime = output.output_format === 'png' ? 'image/png' : 'image/jpeg';
					message_content.push({
						type: 'image',
						source: {
							type: 'base64',
							media_type: mime,
							data: output.result,
						},
						meta: {
							id: output.id,
							status: output.status,
							prompt: output.revised_prompt,
							size: output.size,
						},
					});
					break;

				case 'function_call':
					message_content.push({
						type: 'function',
						content: [
							{
								id: output.call_id,
								name: output.name,
								arguments: output.arguments ? JSON.parse(output.arguments) : {},
							},
						],
					});
					break;

				case 'reasoning':
					message_content.push({
						type: 'reasoning',
						content: output.summary?.length ? output.summary.map(s => s.text).join('\n') : null,
						original: output,
					});
					break;
			}
		}

		return [
			new Message('assistant', message_content),
		];
	}

	async countTokens(thread) {
		try {
			const model = (await this.getModels()).get(thread.state.model);
			const encoder = encoding_for_model(model.tiktoken || model.name);

			const texts = [];
			for (let message of thread.messages)
				texts.push(message.content.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(''));
			return encoder.encode(texts.join('')).length;
		} catch (e) {
			throw new Error('Error while counting tokens');
		}
	}

	convertMessage(message, model) {
		const messages = [],
			role = message.role === 'system' ? this.system_role_name : message.role;

		for (let c of message.content) {
			switch (c.type) {
				case 'text':
					messages.push({
						role,
						content: c.content,
					});
					break;

				case 'image':
					messages.push({
						role,
						content: [
							c.meta.id ? {
								type: 'image_generation_call',
								id: c.meta.id,
								result: c.source.data,
								status: c.meta.status,
							} : {
								type: 'input_image',
								image_url: c.content.type === 'base64' ? 'data:' + c.content.mime + ';base64,' + c.content.data : c.content.data,
								detail: c.content.detail || 'auto',
							},
						],
					});
					break;

				case 'audio':
					if (model.audio) {
						if (c.content.type !== 'base64')
							throw new Error('Audio content must be base64 encoded for this model');
						if (!['audio/mpeg', 'audio/wav'].includes(c.content.mime))
							throw new Error('Audio content must have a valid MIME type');

						messages.push({
							role,
							content: [
								{
									type: 'input_audio',
									input_audio: {
										data: c.content.data,
										format: c.content.mime === 'audio/mpeg' ? 'mp3' : 'wav',
									},
								},
							],
						});
					} else if (c.content.transcription) {
						messages.push({
							role,
							content: '[transcribed] ' + c.content.transcription,
						});
					} else {
						throw new Error('Audio content is not supported by this model');
					}
					break;

				case 'function':
					if (model.tools) {
						messages.push({
							type: 'function_call',
							call_id: c.content[0].id,
							name: c.content[0].name,
							arguments: c.content[0].arguments ? JSON.stringify(c.content[0].arguments) : '{}',
						});
					} else {
						messages.push({
							role,
							content: c.content.map(f => '```CALL \n' + f.name + '\n' + JSON.stringify(f.arguments || {}) + '\n```').join("\n\n"),
						});
					}
					break;

				case 'function_response':
					if (model.tools) {
						messages.push({
							type: 'function_call_output',
							call_id: c.content.id,
							output: JSON.stringify(c.content.response),
						});
					} else {
						messages.push({
							role: 'user',
							content: 'FUNCTION RESPONSE:\n' + JSON.stringify(c.content.response),
						});
					}
					break;

				case 'reasoning':
					messages.push(c.original);
					break;

				default:
					throw new Error('Message type unsupported by this model');
			}
		}

		return messages;
	}
}
