// Helpers that build canned async iterables mirroring the SDK shapes used by each provider.

export function asyncIterable(events) {
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				async next() {
					if (i >= events.length)
						return {done: true, value: undefined};
					return {done: false, value: events[i++]};
				},
			};
		},
	};
}

// OpenAI Responses API streaming object: async iterable + .finalResponse()
export function openAiResponsesStream(events, finalResponse) {
	return {
		...asyncIterable(events),
		async finalResponse() {
			return finalResponse;
		},
	};
}

// Anthropic messages.stream() object: async iterable + .finalMessage()
export function anthropicMessagesStream(events, finalMessage) {
	return {
		...asyncIterable(events),
		async finalMessage() {
			return finalMessage;
		},
	};
}

// A fake thread that exposes whatever Model.generate() looks at.
export function fakeThread({messages = [], state = {model: 'fake'}} = {}) {
	return {messages, state};
}

// Drain a generator: collect yielded deltas and the final return value.
export async function drain(it) {
	const deltas = [];
	let step = await it.next();
	while (!step.done) {
		deltas.push(step.value);
		step = await it.next();
	}
	return {deltas, value: step.value};
}
