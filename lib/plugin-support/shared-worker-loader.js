const {EventEmitter, on} = require('events');
const {workerData, parentPort} = require('worker_threads'); // eslint-disable-line node/no-unsupported-features/node-builtins
const nowAndTimers = require('../now-and-timers');
const pkg = require('../../package.json');

// Map of active test workers, used in receiveMessages() to get a reference to
// the TestWorker instance, and relevant release functions.
const activeTestWorkers = new Map();

class TestWorker {
	constructor(id, file) {
		this.id = id;
		this.file = file;
	}

	defer(fn) {
		let released = false;
		const release = async () => {
			if (released) {
				return;
			}

			released = true;
			if (activeTestWorkers.has(this.id)) {
				activeTestWorkers.get(this.id).releaseFns.delete(release);
			}

			await fn();
		};

		activeTestWorkers.get(this.id).releaseFns.add(release);

		return release;
	}

	publish(data) {
		return publishMessage(this, data);
	}

	async * subscribe() {
		yield * receiveMessages(this);
	}
}

class ReceivedMessage {
	constructor(testWorker, id, data) {
		this.testWorker = testWorker;
		this.id = id;
		this.data = data;
	}

	reply(data) {
		return publishMessage(this.testWorker, data, this.id);
	}
}

// Ensure that, no matter how often it's received, we have a stable message
// object.
const messageCache = new WeakMap();

// Allow micro tasks to finish processing the previous message.
const turn = () => new Promise(resolve => {
	nowAndTimers.setImmediate(resolve);
});

async function * receiveMessages(fromTestWorker, replyTo) {
	for await (const [evt] of on(parentPort, 'message')) {
		if (fromTestWorker !== undefined) {
			if (evt.type === 'deregister-test-worker' && evt.id === fromTestWorker.id) {
				return;
			}

			if (evt.type === 'message' && evt.testWorkerId !== fromTestWorker.id) {
				continue;
			}
		}

		if (evt.type !== 'message') {
			continue;
		}

		if (replyTo === undefined && evt.replyTo !== undefined) {
			continue;
		}

		if (replyTo !== undefined && evt.replyTo !== replyTo) {
			continue;
		}

		await turn();

		const active = activeTestWorkers.get(evt.testWorkerId);
		if (active === undefined) {
			return;
		}

		let message = messageCache.get(evt);
		if (message === undefined) {
			message = new ReceivedMessage(active.instance, evt.messageId, evt.data);
			messageCache.set(evt, message);
		}

		yield message;
	}
}

let messageCounter = 0;
const messageIdPrefix = `${workerData.id}/message`;
const nextMessageId = () => `${messageIdPrefix}/${++messageCounter}`;

function publishMessage(testWorker, data, replyTo) {
	const id = nextMessageId();
	parentPort.postMessage({
		type: 'message',
		messageId: id,
		testWorkerId: testWorker.id,
		data,
		replyTo
	});

	return {
		id,
		async * replies() {
			yield * receiveMessages(testWorker, id);
		}
	};
}

function broadcastMessage(data) {
	const id = nextMessageId();
	parentPort.postMessage({
		type: 'broadcast',
		messageId: id,
		data
	});

	return {
		id,
		async * replies() {
			yield * receiveMessages(undefined, id);
		}
	};
}

const loadFactory = async () => {
	try {
		const mod = require(workerData.filename);
		if (typeof mod === 'function') {
			return mod;
		}

		return mod.default;
	} catch (error) {
		if (error && (error.code === 'ERR_REQUIRE_ESM' || (error.code === 'MODULE_NOT_FOUND' && workerData.filename.startsWith('file://')))) {
			const {default: factory} = await import(workerData.filename); // eslint-disable-line node/no-unsupported-features/es-syntax
			return factory;
		}

		throw error;
	}
};

let signalAvailable = () => {
	parentPort.postMessage({type: 'available'});
	signalAvailable = () => {};
};

let fatal;
loadFactory(workerData.filename).then(factory => {
	if (typeof factory !== 'function') {
		throw new TypeError(`Missing default factory function export for shared worker plugin at ${workerData.filename}`);
	}

	factory({
		negotiateProtocol(supported) {
			if (!supported.includes('experimental')) {
				fatal = new Error(`This version of AVA (${pkg.version}) is not compatible with shared worker plugin at ${workerData.filename}`);
				throw fatal;
			}

			const events = new EventEmitter();
			const produceTestWorker = instance => events.emit('testWorker', instance);

			parentPort.on('message', async message => {
				if (message.type === 'register-test-worker') {
					const {id, file} = message;
					const instance = new TestWorker(id, file);

					activeTestWorkers.set(id, {instance, releaseFns: new Set()});

					produceTestWorker(instance);
				}

				if (message.type === 'deregister-test-worker') {
					const {id} = message;
					const {releaseFns} = activeTestWorkers.get(id);
					activeTestWorkers.delete(id);

					// Run possibly asynchronous release functions serially, in reverse
					// order. Any error will crash the worker.
					for await (const fn of [...releaseFns].reverse()) {
						await fn();
					}
				}
			});

			return {
				initialData: workerData.initialData,
				protocol: 'experimental',

				broadcast(data) {
					signalAvailable();
					return broadcastMessage(data);
				},

				async * subscribe() {
					yield * receiveMessages();
				},

				async * testWorkers() {
					for await (const [worker] of on(events, 'testWorker')) {
						yield worker;
					}
				}
			};
		}
	});
}).catch(error => {
	if (fatal === undefined) {
		fatal = error;
	}
}).finally(() => {
	if (fatal === undefined) {
		signalAvailable();
	} else {
		process.nextTick(() => {
			throw fatal;
		});
	}
});