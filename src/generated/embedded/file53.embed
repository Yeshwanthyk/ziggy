import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");
const HELPER_SETUP_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
export const LINUX_HELPER_PROTOCOL_VERSION = 4;
export const LINUX_HELPER_PATH = process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH
    || path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "linux-bridge");
async function isExecutable(filePath) {
    try {
        await access(filePath, fsConstants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function runProcess(command, args, timeoutMs, signal, env) {
    if (signal?.aborted)
        throw new Error("Operation aborted.");
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (error)
                reject(error);
            else
                resolve();
        };
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            finish(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
        }, timeoutMs);
        const onAbort = () => { child.kill("SIGTERM"); finish(new Error("Operation aborted.")); };
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
            if (code === 0)
                return finish();
            const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
            finish(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
        });
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
async function waitForShared(promise, signal) {
    if (!signal)
        return await promise;
    if (signal.aborted)
        throw new Error("Operation aborted.");
    return await new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error("Operation aborted."));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
        });
    });
}
export class LinuxHelperClient {
    installChecked = false;
    installPromise;
    child;
    processPromise;
    buffer = "";
    pending = new Map();
    helperPath;
    setupHelperScript;
    constructor(options = {}) {
        this.helperPath = options.helperPath ?? LINUX_HELPER_PATH;
        this.setupHelperScript = options.setupHelperScript ?? SETUP_HELPER_SCRIPT;
    }
    dispose() {
        this.rejectPending(new Error("Linux helper closed because the Pi session ended."));
        const child = this.child;
        this.child = undefined;
        if (!child)
            return;
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill("SIGTERM");
        child.unref();
    }
    rejectPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.buffer = "";
    }
    async ensureInstalled(signal) {
        if ((await isExecutable(this.helperPath)) && this.installChecked)
            return;
        if (!this.installPromise) {
            const installPromise = (async () => {
                await runProcess(process.execPath, [this.setupHelperScript, "--platform", "linux", "--runtime"], HELPER_SETUP_TIMEOUT_MS, undefined, {
                    ...process.env,
                    ELECTRON_RUN_AS_NODE: "1",
                    BUN_BE_BUN: "1",
                    PI_COMPUTER_USE_LINUX_HELPER_PATH: this.helperPath,
                });
                if (!(await isExecutable(this.helperPath)))
                    throw new Error(`Failed to install Linux helper at ${this.helperPath}.`);
                this.installChecked = true;
            })();
            this.installPromise = installPromise;
            installPromise.then(() => { if (this.installPromise === installPromise)
                this.installPromise = undefined; }, () => { if (this.installPromise === installPromise)
                this.installPromise = undefined; });
        }
        await waitForShared(this.installPromise, signal);
    }
    async process(signal) {
        await this.ensureInstalled(signal);
        if (this.processPromise)
            return await waitForShared(this.processPromise, signal);
        if (this.child && this.child.exitCode === null && !this.child.killed)
            return this.child;
        if (!this.processPromise) {
            const processPromise = this.startProcess();
            this.processPromise = processPromise;
            processPromise.then(() => { if (this.processPromise === processPromise)
                this.processPromise = undefined; }, () => { if (this.processPromise === processPromise)
                this.processPromise = undefined; });
        }
        return await waitForShared(this.processPromise, signal);
    }
    async startProcess() {
        const child = spawn(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdin.setDefaultEncoding("utf8");
        child.stdout.on("data", (chunk) => this.onStdout(chunk));
        child.on("exit", (code, signalName) => {
            if (this.child !== child)
                return;
            this.child = undefined;
            this.rejectPending(new Error(`Linux helper exited${signalName ? ` on ${signalName}` : ` with code ${code ?? "unknown"}`}.`));
        });
        child.on("error", (error) => {
            if (this.child !== child)
                return;
            this.child = undefined;
            this.rejectPending(error);
        });
        this.child = child;
        this.buffer = "";
        return await new Promise((resolve, reject) => {
            child.once("spawn", () => resolve(child));
            child.once("error", reject);
        });
    }
    onStdout(chunk) {
        this.buffer += chunk;
        for (;;) {
            const newline = this.buffer.indexOf("\n");
            if (newline < 0)
                return;
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            const pending = this.pending.get(parsed.id);
            if (!pending)
                continue;
            this.pending.delete(parsed.id);
            clearTimeout(pending.timer);
            if (parsed.protocolVersion !== LINUX_HELPER_PROTOCOL_VERSION) {
                pending.reject(new Error(`Linux helper protocol mismatch: expected ${LINUX_HELPER_PROTOCOL_VERSION}, got ${parsed.protocolVersion ?? "unknown"}. Restart Pi to use the installed helper.`));
            }
            else if (parsed.ok === true) {
                pending.resolve(parsed.result);
            }
            else {
                const error = new Error(parsed.error?.message ?? "Linux helper command failed.");
                error.code = parsed.error?.code;
                pending.reject(error);
            }
        }
    }
    async command(cmd, args = {}, options) {
        const child = await this.process(options?.signal);
        const id = randomUUID();
        const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
        return await new Promise((resolve, reject) => {
            const onAbort = () => {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new Error("Operation aborted."));
            };
            const timer = setTimeout(() => {
                options?.signal?.removeEventListener("abort", onAbort);
                this.pending.delete(id);
                reject(new Error(`Helper command '${cmd}' timed out after ${timeoutMs}ms.`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => { options?.signal?.removeEventListener("abort", onAbort); resolve(value); },
                reject: (error) => { options?.signal?.removeEventListener("abort", onAbort); reject(error); },
                timer,
            });
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            child.stdin.write(`${JSON.stringify({ protocolVersion: LINUX_HELPER_PROTOCOL_VERSION, id, cmd, args })}\n`, (error) => {
                if (!error)
                    return;
                options?.signal?.removeEventListener("abort", onAbort);
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            });
        });
    }
}
export const linuxHelper = new LinuxHelperClient();
