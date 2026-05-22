export function createInputChannel() {
	const queue = [];
	const waiters = [];
	let closed = false;

	const channel = {
		send(item) {
			if (closed)
				return;
			if (waiters.length)
				waiters.shift().resolve({value: item, done: false});
			else
				queue.push(item);
		},
		close() {
			if (closed)
				return;
			closed = true;
			while (waiters.length)
				waiters.shift().resolve({value: undefined, done: true});
		},
		[Symbol.asyncIterator]() {
			return channel;
		},
		async next() {
			if (queue.length)
				return {value: queue.shift(), done: false};
			if (closed)
				return {value: undefined, done: true};
			return new Promise(resolve => waiters.push({resolve}));
		},
		async return() {
			if (!closed) {
				closed = true;
				while (waiters.length)
					waiters.shift().resolve({value: undefined, done: true});
			}
			return {value: undefined, done: true};
		},
	};
	return channel;
}
