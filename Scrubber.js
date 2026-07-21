import ContextHandler from "./ContextHandler.js";

/**
 * Context handler that retroactively removes heavy content from old messages,
 * once the conversation has moved past them. Unlike Summarizer (which rewrites
 * whole spans of history into a summary), Scrubber is surgical: it replaces
 * individual heavy blocks — images, audio, oversized texts and tool results —
 * with short text stubs, keeping the message structure (roles, tool pairing)
 * intact. Mutates the thread in place, so the scrub persists with the normal
 * thread storeState at turn end.
 *
 * Messages belonging to the last `keep_last` user turns are never touched, so
 * the model always has the recent originals while it is still working on them.
 * System messages are never touched.
 *
 * An image or audio block may carry a `path` in its content (where the source
 * file lives on disk); the stub then mentions it, so an agent with filesystem
 * tools can re-read the original if it turns out to still be needed.
 */
export default class Scrubber extends ContextHandler {
	constructor(options = {}) {
		super();
		this.options = {
			keep_last: 3, // most recent user messages whose turns are fully protected
			max_text_length: 20000, // chars; longer text/tool_result contents get trimmed
			keep_chars: 1000, // head kept when trimming an oversized text
			images: true,
			audio: true,
			texts: true, // oversized text blocks in user messages
			tool_results: true, // oversized tool responses
			...options,
		};
	}

	async handle(thread) {
		const boundary = this.protectedBoundary(thread.messages);

		let scrubbed = 0;
		for (let i = 0; i < boundary; i++)
			scrubbed += this.scrubMessage(thread.messages[i]);

		// Exposed for consumers that scrub on demand (e.g. a model-invoked
		// "forget" tool) and want to report how much was removed.
		this.last_scrubbed = scrubbed;

		if (scrubbed && this.agent)
			await this.agent.log('scrub', {thread: thread.id, blocks: scrubbed});

		return thread;
	}

	// Index of the keep_last-th user message counting from the end; everything
	// before it is old enough to scrub. 0 (nothing to scrub) when the thread
	// doesn't have that many user messages yet.
	protectedBoundary(messages) {
		let seen = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') {
				seen++;
				if (seen >= this.options.keep_last)
					return i;
			}
		}
		return 0;
	}

	// Returns the number of blocks replaced or trimmed. Idempotent: stubs and
	// already-trimmed blocks are always below the thresholds.
	scrubMessage(message) {
		if (message.role === 'system')
			return 0;

		let scrubbed = 0;
		message.content = message.content.map(block => {
			const replacement = this.scrubBlock(block, message.role);
			if (replacement !== block)
				scrubbed++;
			return replacement;
		});
		return scrubbed;
	}

	scrubBlock(block, role) {
		switch (block?.type) {
			case 'image':
				if (this.options.images)
					return this.stub('image', block.content?.path);
				break;

			case 'audio':
				if (this.options.audio) {
					const transcription = block.content?.transcription;
					const stub = this.stub('audio recording', block.content?.path);
					return transcription
						? {type: 'text', content: stub.content + "\nTranscription: " + transcription}
						: stub;
				}
				break;

			case 'text':
				if (this.options.texts && role === 'user' && typeof block.content === 'string' && block.content.length > this.options.max_text_length) {
					const removed = block.content.length - this.options.keep_chars;
					return {
						type: 'text',
						content: block.content.slice(0, this.options.keep_chars)
							+ "\n[... " + removed + " characters removed from context to save space]",
					};
				}
				break;

			case 'tool_result': {
				if (!this.options.tool_results)
					break;
				const response = block.content?.response;
				const serialized = typeof response === 'string' ? response : JSON.stringify(response);
				if (typeof serialized === 'string' && serialized.length > this.options.max_text_length) {
					const removed = serialized.length - this.options.keep_chars;
					return {
						...block,
						content: {
							...block.content,
							response: serialized.slice(0, this.options.keep_chars)
								+ "\n[... " + removed + " characters removed from context to save space]",
						},
					};
				}
				break;
			}
		}

		return block;
	}

	stub(what, path) {
		return {
			type: 'text',
			content: path
				? "[" + what + " removed from context to save space — the original file is still available at " + path + ", read it again only if actually needed]"
				: "[" + what + " removed from context to save space — ask the user to send it again if actually needed]",
		};
	}
}
