import { AsyncLocalStorage } from "node:async_hooks";
import { restoreOutline, serializeOutline } from "./outline.mjs";
import { StateStore } from "./runtime.mjs";
export class SavedStates {
    store = new StateStore(128);
    operations = new AsyncLocalStorage();
    current() {
        const state = this.operations.getStore();
        if (!state)
            throw new Error("Computer-use operation state is unavailable.");
        return state;
    }
    get(stateId) {
        return this.store.get(stateId);
    }
    set(record) {
        this.store.set(record);
    }
    clear() {
        this.store.clear();
    }
    hydrate(record) {
        if (!record)
            return {};
        if (record.value.kind === "browser") {
            const outline = restoreOutline(record.value.outline);
            return {
                currentCapture: { stateId: record.stateId, width: 0, height: 0, scaleFactor: 1, timestamp: record.value.snapshot.capturedAt },
                currentLook: {
                    lookId: record.value.snapshot.snapshotId,
                    capturedAt: record.value.snapshot.capturedAt / 1000,
                    window: { windowId: 0, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1, isModal: false, role: "document", subrole: "" },
                    outline: outline.root,
                    timings: {},
                    parsedOutline: outline,
                },
                currentOutline: outline,
                resourceKey: record.resourceKey,
                epoch: record.epoch,
                browserSnapshot: record.value.snapshot,
                contextId: record.value.snapshot.contextId,
            };
        }
        const outline = restoreOutline(record.value.outline);
        return {
            currentTarget: { ...record.value.target },
            currentCapture: { ...record.value.capture },
            currentStateTarget: { pid: record.value.target.pid, windowId: record.value.target.windowId, windowRef: record.value.target.windowRef },
            currentImageMode: record.value.imageMode,
            currentLook: { ...record.value.look, outline: outline.root, parsedOutline: outline },
            currentOutline: outline,
            currentNote: record.value.note ? structuredClone(record.value.note) : undefined,
            resourceKey: record.resourceKey,
            epoch: record.epoch,
        };
    }
    saveDesktop(state, resourceKey, epoch) {
        if (!state.currentTarget || !state.currentCapture || !state.currentLook || !state.currentOutline)
            return;
        this.store.set({
            stateId: state.currentCapture.stateId,
            resourceKey,
            epoch,
            value: {
                kind: "desktop",
                target: { ...state.currentTarget },
                capture: { ...state.currentCapture },
                look: {
                    lookId: state.currentLook.lookId,
                    capturedAt: state.currentLook.capturedAt,
                    window: structuredClone(state.currentLook.window),
                    image: state.currentLook.image ? { ...state.currentLook.image } : undefined,
                    timings: { ...state.currentLook.timings },
                    readText: state.currentLook.readText ? { ...state.currentLook.readText } : undefined,
                },
                outline: serializeOutline(state.currentOutline),
                note: state.currentNote ? structuredClone(state.currentNote) : undefined,
                imageMode: state.currentImageMode,
            },
        });
    }
}
