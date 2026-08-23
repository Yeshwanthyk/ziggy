import { randomUUID } from "node:crypto";
export class StaleResourceStateError extends Error {
    resourceKey;
    expectedEpoch;
    actualEpoch;
    constructor(resourceKey, expectedEpoch, actualEpoch) {
        super(`State is stale for ${resourceKey}: expected epoch ${expectedEpoch}, current epoch ${actualEpoch}.`);
        this.resourceKey = resourceKey;
        this.expectedEpoch = expectedEpoch;
        this.actualEpoch = actualEpoch;
        this.name = "StaleResourceStateError";
    }
}
/** Bounded insertion-ordered store for immutable agent-facing observations. */
export class StateStore {
    limit;
    records = new Map();
    constructor(limit = 128) {
        this.limit = limit;
    }
    create(resourceKey, epoch, value) {
        const record = { stateId: randomUUID(), resourceKey, epoch, value };
        this.set(record);
        return record;
    }
    set(record) {
        this.records.delete(record.stateId);
        this.records.set(record.stateId, record);
        while (this.records.size > this.limit) {
            const oldest = this.records.keys().next().value;
            if (!oldest)
                break;
            this.records.delete(oldest);
        }
    }
    get(stateId) {
        return this.records.get(stateId);
    }
    clear() {
        this.records.clear();
    }
    get size() {
        return this.records.size;
    }
}
/**
 * Orders live operations per physical resource while allowing unrelated
 * resources to overlap. Cached state queries bypass this scheduler entirely.
 */
export class ResourceScheduler {
    resources = new Map();
    closed = false;
    epoch(resourceKey) {
        return this.resource(resourceKey).epoch;
    }
    restoreEpoch(resourceKey, epoch) {
        const record = this.resource(resourceKey);
        record.epoch = Math.max(record.epoch, Math.max(0, Math.trunc(epoch)));
    }
    async read(resourceKey, work) {
        return await this.enqueue(resourceKey, async (record) => ({ value: await work(record.epoch), epoch: record.epoch }));
    }
    async readAt(resourceKey, expectedEpoch, work) {
        return await this.enqueue(resourceKey, async (record) => {
            if (record.epoch !== expectedEpoch)
                throw new StaleResourceStateError(resourceKey, expectedEpoch, record.epoch);
            return { value: await work(record.epoch), epoch: record.epoch };
        });
    }
    async write(resourceKey, baseEpoch, work) {
        return await this.enqueue(resourceKey, async (record) => {
            if (record.epoch !== baseEpoch)
                throw new StaleResourceStateError(resourceKey, baseEpoch, record.epoch);
            const nextEpoch = record.epoch + 1;
            // Invalidate the base state before dispatch. If native execution becomes
            // uncertain or throws after a partial effect, later writes still fail safe.
            record.epoch = nextEpoch;
            return { value: await work(nextEpoch), epoch: nextEpoch };
        });
    }
    async drain() {
        await Promise.all([...this.resources.values()].map((record) => record.tail.catch(() => undefined)));
    }
    async close() {
        this.closed = true;
        await this.drain();
        this.resources.clear();
    }
    resource(resourceKey) {
        let record = this.resources.get(resourceKey);
        if (!record) {
            record = { epoch: 0, tail: Promise.resolve() };
            this.resources.set(resourceKey, record);
        }
        return record;
    }
    async enqueue(resourceKey, work) {
        if (this.closed)
            throw new Error("Computer-use session is shutting down.");
        const record = this.resource(resourceKey);
        const previous = record.tail;
        let release;
        const next = new Promise((resolve) => { release = resolve; });
        record.tail = previous.catch(() => undefined).then(() => next);
        await previous.catch(() => undefined);
        try {
            return await work(record);
        }
        finally {
            release();
        }
    }
}
