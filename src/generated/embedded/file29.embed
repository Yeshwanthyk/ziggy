import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
const DEFAULT_CONFIG = {
    browser_use: true,
    headless: false,
    cursor_overlay: true,
    managed_browser: "chrome",
};
let activeConfig = { ...DEFAULT_CONFIG };
let activeLoadedConfig = { config: activeConfig, sources: [], env: {} };
function parseBoolean(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value === 1 ? true : value === 0 ? false : undefined;
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled"].includes(normalized))
        return true;
    if (["0", "false", "no", "off", "disabled"].includes(normalized))
        return false;
    return undefined;
}
function normalizePartial(raw) {
    if (!raw || typeof raw !== "object")
        return {};
    const source = raw.computer_use && typeof raw.computer_use === "object" ? raw.computer_use : raw;
    const out = {};
    const browserUse = parseBoolean(source.browser_use);
    const headless = parseBoolean(source.headless);
    const cursorOverlay = parseBoolean(source.cursor_overlay);
    if (browserUse !== undefined)
        out.browser_use = browserUse;
    if (headless !== undefined)
        out.headless = headless;
    if (cursorOverlay !== undefined)
        out.cursor_overlay = cursorOverlay;
    const managedBrowser = source.managed_browser;
    if (managedBrowser === "helium" || managedBrowser === "chrome")
        out.managed_browser = managedBrowser;
    return out;
}
function readConfigFile(filePath) {
    if (!existsSync(filePath))
        return { path: filePath, exists: false };
    try {
        const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
        return { path: filePath, exists: true, values: normalizePartial(parsed) };
    }
    catch (error) {
        return { path: filePath, exists: true, error: error instanceof Error ? error.message : String(error) };
    }
}
function readEnv() {
    const out = {};
    const browserUse = parseBoolean(process.env.PI_COMPUTER_USE_BROWSER_USE);
    const headless = parseBoolean(process.env.PI_COMPUTER_USE_HEADLESS);
    const cursorOverlay = parseBoolean(process.env.PI_COMPUTER_USE_CURSOR_OVERLAY);
    if (browserUse !== undefined)
        out.browser_use = browserUse;
    if (headless !== undefined)
        out.headless = headless;
    if (cursorOverlay !== undefined)
        out.cursor_overlay = cursorOverlay;
    const managedBrowser = process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
    if (managedBrowser === "helium" || managedBrowser === "chrome")
        out.managed_browser = managedBrowser;
    return out;
}
export function loadComputerUseConfig(cwd) {
    const sources = [
        readConfigFile(path.join(getAgentDir(), "extensions", "pi-computer-use.json")),
        readConfigFile(path.join(cwd, ".pi", "computer-use.json")),
    ];
    const env = readEnv();
    const config = { ...DEFAULT_CONFIG };
    for (const source of sources) {
        if (source.values)
            Object.assign(config, source.values);
    }
    Object.assign(config, env);
    activeConfig = config;
    activeLoadedConfig = { config, sources, env };
    return activeLoadedConfig;
}
export function getComputerUseConfig() {
    return activeConfig;
}
export function getLoadedComputerUseConfig() {
    return activeLoadedConfig;
}
export function isHeadlessMode() {
    return activeConfig.headless;
}
export function isBrowserUseEnabled() {
    return activeConfig.browser_use;
}
