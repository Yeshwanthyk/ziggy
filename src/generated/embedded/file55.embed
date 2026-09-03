import { getComputerUseConfig } from "../../config.mjs";
import { parseLookResponse } from "../../outline.mjs";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.mjs";
import { macosHelper } from "./helper.mjs";
function parseApps(result) {
    const array = Array.isArray(result) ? result : result?.apps;
    if (!Array.isArray(array))
        return [];
    return array
        .map((raw) => {
        const pid = Math.trunc(toFiniteNumber(raw?.pid, NaN));
        if (!Number.isFinite(pid) || pid <= 0)
            return undefined;
        const appName = toOptionalString(raw?.appName) ?? "Unknown App";
        return {
            appName,
            bundleId: toOptionalString(raw?.bundleId),
            pid,
            isFrontmost: toBoolean(raw?.isFrontmost),
        };
    })
        .filter((item) => Boolean(item));
}
function parseFramePoints(raw) {
    const frame = raw?.framePoints ?? {};
    return {
        x: toFiniteNumber(frame.x, 0),
        y: toFiniteNumber(frame.y, 0),
        w: Math.max(1, toFiniteNumber(frame.w, 1)),
        h: Math.max(1, toFiniteNumber(frame.h, 1)),
    };
}
function parseRoots(result) {
    const array = Array.isArray(result) ? result : result?.roots;
    if (!Array.isArray(array))
        return [];
    return array.map((raw) => {
        const metadata = typeof raw?.metadata === "object" && raw.metadata !== null ? raw.metadata : {};
        const kind = ["window", "menu", "sheet", "popover", "dialog"].includes(raw?.kind) ? raw.kind : "window";
        return {
            kind,
            rootRef: toOptionalString(raw?.rootRef ?? raw?.windowRef),
            windowRef: toOptionalString(raw?.windowRef ?? raw?.rootRef),
            windowId: Number.isFinite(raw?.windowId) ? Math.trunc(raw.windowId) : undefined,
            pid: Number.isFinite(raw?.pid) ? Math.trunc(raw.pid) : undefined,
            appName: toOptionalString(raw?.appName),
            bundleId: toOptionalString(raw?.bundleId),
            title: toOptionalString(raw?.title) ?? "",
            role: toOptionalString(raw?.role),
            subrole: toOptionalString(raw?.subrole),
            framePoints: parseFramePoints(raw),
            scaleFactor: Math.max(1, toFiniteNumber(raw?.scaleFactor, 1)),
            zOrder: Math.trunc(toFiniteNumber(raw?.zOrder, 0)),
            isMinimized: toBoolean(raw?.isMinimized),
            isOnscreen: toBoolean(raw?.isOnscreen),
            isMain: toBoolean(raw?.isMain),
            isFocused: toBoolean(raw?.isFocused),
            isModal: toBoolean(raw?.isModal),
            metadata,
        };
    });
}
function helperAction(request) {
    if (!("focus" in request.target))
        return { ...request };
    return { ...request, target: request.target.focus, params: { ...request.params, preserveFocus: true } };
}
export const macosBackend = {
    async listApps(signal) {
        return parseApps(await macosHelper.command("listApps", {}, { signal }));
    },
    async listRoots(query, signal) {
        return parseRoots(await macosHelper.command("listRoots", {
            ...(Number.isFinite(query.pid) ? { pid: Math.trunc(query.pid) } : {}),
            ...(query.title?.trim() ? { title: query.title.trim() } : {}),
        }, { signal }));
    },
    async getFrontmost(signal) {
        const result = await macosHelper.command("getFrontmost", {}, { signal });
        const pid = Math.trunc(toFiniteNumber(result?.pid, NaN));
        if (!Number.isFinite(pid) || pid <= 0) {
            throw new Error("No frontmost app was available for screenshot targeting.");
        }
        return {
            appName: toOptionalString(result?.appName) ?? "Unknown App",
            bundleId: toOptionalString(result?.bundleId),
            pid,
            windowTitle: toOptionalString(result?.windowTitle),
            windowId: Number.isFinite(result?.windowId) ? Math.trunc(result.windowId) : undefined,
        };
    },
    async focusWindow(target, signal) {
        return await macosHelper.command("focusWindow", { ...target }, { signal });
    },
    async observe(request, options) {
        return parseLookResponse(await macosHelper.command("look", {
            baseLookId: request.baseLookId,
            windowId: request.target.windowId,
            windowRef: request.target.rootRef,
            maxDimension: request.maxDimension,
            readText: request.readText,
            scopeRef: request.scopeRef,
            includeImage: request.includeImage,
        }, options));
    },
    async act(request, options) {
        return await macosHelper.command("act", { ...helperAction(request), cursorOverlay: getComputerUseConfig().cursor_overlay }, options);
    },
    async actBatch(requests, options) {
        const cursorOverlay = getComputerUseConfig().cursor_overlay;
        return await macosHelper.command("actBatch", { actions: requests.map((request) => ({ ...helperAction(request), cursorOverlay })) }, options);
    },
    async readText(args, options) {
        return await macosHelper.command("axReadText", { ...args }, options);
    },
    async waitFor(args, options) {
        return await macosHelper.command("axWaitFor", { ...args }, options);
    },
};
