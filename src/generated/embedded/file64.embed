import { parseLookResponse } from "../../outline.mjs";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.mjs";
import { WINDOWS_HELPER_PROTOCOL_VERSION, windowsHelper } from "./helper.mjs";
import { assertPlatformArchitecture } from "../architecture.mjs";
function normalizedProcessName(appName) {
    return appName.toLowerCase().replace(/\.exe$/i, "");
}
function classifyBrowser(appName) {
    switch (normalizedProcessName(appName)) {
        case "chrome":
        case "chromium":
            return "chrome";
        case "msedge":
        case "edge":
            return "edge";
        case "brave":
        case "brave-browser":
            return "brave";
        case "firefox":
            return "firefox";
        case "vivaldi":
            return "vivaldi";
        case "opera":
        case "opera_gx":
            return "opera";
        default:
            return false;
    }
}
function parseFramePoints(raw) {
    const frame = raw?.framePoints ?? raw?.bounds ?? {};
    return {
        x: toFiniteNumber(frame.x, 0),
        y: toFiniteNumber(frame.y, 0),
        w: Math.max(1, toFiniteNumber(frame.w ?? frame.width, 1)),
        h: Math.max(1, toFiniteNumber(frame.h ?? frame.height, 1)),
    };
}
function parseRootKind(raw) {
    return raw === "menu" || raw === "dialog" || raw === "popover" || raw === "window" ? raw : "window";
}
function parseRoots(result) {
    const array = Array.isArray(result) ? result : result?.roots;
    if (!Array.isArray(array))
        return [];
    return array.map((raw, index) => {
        return {
            kind: parseRootKind(raw?.kind),
            rootRef: toOptionalString(raw?.rootRef ?? raw?.windowRef ?? raw?.ref),
            windowRef: toOptionalString(raw?.windowRef ?? raw?.rootRef ?? raw?.ref),
            windowId: Number.isFinite(raw?.windowId) ? Math.trunc(raw.windowId) : undefined,
            pid: Number.isFinite(raw?.pid) ? Math.trunc(raw.pid) : undefined,
            appName: toOptionalString(raw?.appName ?? raw?.processName),
            bundleId: toOptionalString(raw?.bundleId),
            title: toOptionalString(raw?.title) ?? "",
            role: toOptionalString(raw?.role),
            subrole: toOptionalString(raw?.subrole),
            zOrder: Math.trunc(toFiniteNumber(raw?.zOrder, index)),
            framePoints: parseFramePoints(raw),
            scaleFactor: Math.max(1, toFiniteNumber(raw?.scaleFactor, 1)),
            isOnscreen: raw?.isOnscreen === undefined ? true : toBoolean(raw?.isOnscreen),
            isFocused: toBoolean(raw?.isFocused),
            isMinimized: toBoolean(raw?.isMinimized),
            isMain: toBoolean(raw?.isMain ?? raw?.isFocused),
            isModal: toBoolean(raw?.isModal),
            metadata: raw?.metadata,
        };
    });
}
function appsFromRoots(roots) {
    const seen = new Set();
    return roots.flatMap((root) => {
        if (!root.pid || seen.has(root.pid))
            return [];
        seen.add(root.pid);
        return [{ appName: root.appName ?? "Unknown", bundleId: root.bundleId, pid: root.pid, isFrontmost: root.isFocused }];
    });
}
function helperAction(request) {
    if (!("focus" in request.target))
        return { ...request };
    return { ...request, target: request.target.focus, params: { ...request.params, preserveFocus: true } };
}
async function ensureReady(_ctx, state, signal) {
    await windowsHelper.ensureInstalled(signal);
    const diagnostics = await windowsHelper.command("diagnostics", {}, { signal, timeoutMs: 5_000 });
    if (diagnostics?.protocolVersion !== WINDOWS_HELPER_PROTOCOL_VERSION) {
        throw new Error(`Windows helper protocol mismatch: expected ${WINDOWS_HELPER_PROTOCOL_VERSION}, got ${diagnostics?.protocolVersion ?? "unknown"}. Restart Pi to use the installed helper.`);
    }
    assertPlatformArchitecture("Windows", diagnostics);
    return { ...state, lastPermissionCheckAt: Date.now(), helperDiagnostics: diagnostics };
}
export const windowsBackend = {
    name: "windows",
    shutdown() { windowsHelper.dispose(); },
    ensureReady,
    async listApps(signal) {
        return appsFromRoots(parseRoots(await windowsHelper.command("listRoots", {}, { signal })));
    },
    async listRoots(query, signal) {
        const roots = parseRoots(await windowsHelper.command("listRoots", Number.isFinite(query.pid) ? { pid: Math.trunc(query.pid) } : {}, { signal }));
        const title = query.title?.trim().toLowerCase();
        return title ? roots.filter((root) => root.title.trim().toLowerCase().includes(title)) : roots;
    },
    async getFrontmost(signal) {
        const roots = parseRoots(await windowsHelper.command("listRoots", {}, { signal }));
        const focused = roots.find((root) => root.isFocused) ?? roots[0];
        if (!focused?.pid)
            throw new Error("No frontmost window was available.");
        return { appName: focused.appName ?? "Unknown", bundleId: focused.bundleId, pid: focused.pid, windowTitle: focused.title, windowId: focused.windowId, rootRef: focused.rootRef };
    },
    async focusWindow(target, signal) {
        return await windowsHelper.command("focusWindow", { ...target }, { signal });
    },
    async observe(request, options) {
        return parseLookResponse(await windowsHelper.command("look", { ...request.target, baseLookId: request.baseLookId, maxDimension: request.maxDimension, readText: request.readText, scopeRef: request.scopeRef, includeImage: request.includeImage }, options));
    },
    async act(request, options) {
        return await windowsHelper.command("act", helperAction(request), options);
    },
    async actBatch(requests, options) {
        return await windowsHelper.command("actBatch", { actions: requests.map(helperAction) }, options);
    },
    async readText(args, options) {
        return await windowsHelper.command("uiaReadText", { ...args }, options);
    },
    async waitFor(args, options) {
        return await windowsHelper.command("uiaWaitFor", { ...args }, options);
    },
    isBrowserApp(appName) { return classifyBrowser(appName) !== false; },
    isChromeFamilyApp(appName) { return classifyBrowser(appName) === "chrome" || classifyBrowser(appName) === "edge" || classifyBrowser(appName) === "brave"; },
    async openBrowserLocation(target, url, signal) {
        await windowsHelper.command("openBrowserLocation", { ...target, url }, { signal, timeoutMs: 10_000 });
        return true;
    },
};
