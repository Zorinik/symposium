import EventEmitter from 'events';

export default class BufferedEventEmitter extends EventEmitter {
	#buffer = [];

	emit(eventName, ...args) {
		if (this.listenerCount(eventName) > 0)
			return super.emit(eventName, ...args);

		this.#buffer.push({eventName, args});
		return true;
	}

	#flush() {
		for (const {eventName, args} of this.#buffer)
			if (this.listenerCount(eventName) > 0)
				super.emit(eventName, ...args);

		this.#buffer = this.#buffer.filter(({eventName}) => this.listenerCount(eventName) === 0);
	}

	on(eventName, listener, flush = true) {
		super.on(eventName, listener);
		if (flush)
			this.#flush();
		return this;
	}
}
