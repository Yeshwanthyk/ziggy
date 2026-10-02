import { macosBackend } from "./macos/backend.mjs";
import { isBrowserApp, isChromeFamilyApp, openBrowserLocationWithAppleScript } from "./macos/browser.mjs";
import { ensureMacosReady } from "./macos/permissions.mjs";
import { linuxBackend } from "./linux/backend.mjs";
import { windowsBackend } from "./windows/backend.mjs";
const macosPlatformBackend = {
    name: "macos",
    ensureReady: ensureMacosReady,
    listApps: macosBackend.listApps,
    listRoots: macosBackend.listRoots,
    getFrontmost: macosBackend.getFrontmost,
    focusWindow: macosBackend.focusWindow,
    observe: macosBackend.observe,
    act: macosBackend.act,
    actBatch: macosBackend.actBatch,
    readText: macosBackend.readText,
    waitFor: macosBackend.waitFor,
    isBrowserApp,
    isChromeFamilyApp,
    openBrowserLocation: openBrowserLocationWithAppleScript,
};
class UnsupportedPlatformBackend {
    name;
    platform;
    constructor(platform) {
        this.platform = platform;
        this.name = platform === "win32" ? "windows" : "linux";
    }
    unsupported() {
        throw new Error(`pi-computer-use does not support platform '${this.platform}' yet.`);
    }
    async ensureReady() { this.unsupported(); }
    async listApps() { this.unsupported(); }
    async listRoots() { this.unsupported(); }
    async getFrontmost() { this.unsupported(); }
    async focusWindow() { this.unsupported(); }
    async observe() { this.unsupported(); }
    async act() { this.unsupported(); }
    async readText() { this.unsupported(); }
    async waitFor() { this.unsupported(); }
    isBrowserApp() { this.unsupported(); }
    isChromeFamilyApp() { this.unsupported(); }
    async openBrowserLocation() { this.unsupported(); }
}
export function platformBackendForRuntime(platform = process.platform) {
    if (platform === "darwin")
        return macosPlatformBackend;
    if (platform === "win32")
        return windowsBackend;
    if (platform === "linux")
        return linuxBackend;
    return new UnsupportedPlatformBackend(platform);
}
export const currentPlatformBackend = platformBackendForRuntime();
