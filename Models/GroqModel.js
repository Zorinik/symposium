import Model from "../Model.js";
import Groq from "groq-sdk";
import Message from "../Message.js";

export default class GroqModel extends Model {
	groq;

	async getModels() {
		return new Map([
			['llama-3', {
				name: 'llama-3.3-70b-versatile',
				tokens: 128000,
				tools: true,
			}],
			['mixtral-8', {
				name: 'mixtral-8x7b-32768',
				tokens: 32768,
				tools: true,
			}],
		]);
	}

	getGroq() {
		if (!this.groq)
			this.groq = new Groq();

		return this.groq;
	}

	async *generate(model, thread, tools = [], options = {}) {
		const parsed = this.parseOptions(options, tools);
		options = parsed.options;
		tools = parsed.tools;

		let messages = thread.messages;

		if (tools.length && !model.tools) {
			// Se il modello non supporta nativamente gli strumenti, inserisco il prompt ad hoc come ultimo messaggio di sistema
			const tools_prompt = this.promptFromTools(options, tools);
			let system_messages = [], other_messages = [], first_found = false;
			for (let message of messages) {
				if (!first_found && message.role !== 'system')
					first_found = true;

				if (!first_found)
					system_messages.push(message);
				else
					other_messages.push(message);
			}

			system_messages.push(new Message('system', tools_prompt));

			messages = [...system_messages, ...other_messages];
			tools = [];
		}

		const convertedMessages = [];
		for (let m of messages)
			convertedMessages.push(...this.convertMessage(m, model));

		const completion_payload = {
			model: model.name,
			messages: convertedMessages,
			tools: tools.map(t => ({
				type: 'function',
				function: t,
			})),
		};

		if (options.force_tool) {
			completion_payload.tool_choice = {
				type: 'function',
				function: {name: options.force_tool},
			};
		}

		if (!completion_payload.tools.length)
			delete completion_payload.tools;

		const stream = await this.getGroq().chat.completions.create({...completion_payload, stream: true});

		let fullText = '';
		const toolBuffer = new Map();

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta;
			if (!delta)
				continue;

			if (delta.content) {
				fullText += delta.content;
				yield {type: 'text_delta', content: delta.content};
			}

			if (delta.tool_calls) {
				for (const tc of delta.tool_calls) {
					const idx = tc.index;
					if (!toolBuffer.has(idx))
						toolBuffer.set(idx, {id: '', name: '', argumentsRaw: ''});
					const buf = toolBuffer.get(idx);
					if (tc.id)
						buf.id = tc.id;
					if (tc.function?.name)
						buf.name = tc.function.name;
					if (tc.function?.arguments)
						buf.argumentsRaw += tc.function.arguments;
				}
			}
		}

		const toolCalls = [];
		for (const [, buf] of [...toolBuffer.entries()].sort((a, b) => a[0] - b[0])) {
			const tc = {
				id: buf.id,
				name: buf.name,
				arguments: buf.argumentsRaw ? JSON.parse(buf.argumentsRaw) : {},
			};
			toolCalls.push(tc);
			yield {type: 'tool_call', content: tc};
		}

		const message_content = [];
		if (fullText)
			message_content.push({type: 'text', content: fullText});

		if (toolCalls.length)
			message_content.push({type: 'tool_call', content: toolCalls});

		return [
			new Message('assistant', message_content),
		];
	}

	convertMessage(message, model) {
		const messages = [];
		for (let c of message.content) {
			switch (c.type) {
				case 'text':
					messages.push({
						role: message.role,
						content: c.content,
						name: message.name,
					});
					break;

				case 'image':
					messages.push({
						role: message.role,
						content: [
							{
								type: 'image_url',
								image_url: {
									url: c.content.type === 'base64' ? 'data:' + c.content.mime + ';base64,' + c.content.data : c.content.data,
								},
							},
						],
						name: message.name,
					});
					break;

				case 'tool_call':
					if (model.tools) {
						messages.push({
							role: message.role,
							name: message.name,
							tool_calls: c.content.map(tool_call => ({
								id: tool_call.id,
								type: 'function',
								function: {
									name: tool_call.name,
									arguments: tool_call.arguments ? JSON.stringify(tool_call.arguments) : '{}',
								},
							})),
						});
					} else {
						messages.push({
							role: message.role,
							content: c.content.map(t => '```CALL \n' + t.name + '\n' + JSON.stringify(t.arguments || {}) + '\n```').join("\n\n"),
							name: message.name,
						});
					}
					break;

				case 'tool_result':
					if (model.tools) {
						messages.push({
							role: message.role,
							tool_call_id: c.content.id,
							content: JSON.stringify(c.content.response),
							name: message.name,
						});
					} else {
						messages.push({
							role: 'user',
							content: 'TOOL RESPONSE:\n' + JSON.stringify(c.content.response),
							name: message.name,
						});
					}
					break;


				case 'audio':
					if (c.content.transcription) {
						messages.push({
							role: message.role,
							content: '[transcribed] ' + c.content.transcription,
							name: message.name,
						});
					} else {
						throw new Error('Audio content is not supported by this model');
					}
					break;

				default:
					throw new Error('Message type unsupported by this model');
			}
		}

		return messages;
	}
}
