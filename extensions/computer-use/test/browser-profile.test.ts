/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun and Pi loader tests are explicit Promise execution boundaries. */
/* oxlint-disable ziggy/no-unsafe-typescript-syntax, ziggy/no-chained-type-assertions, ziggy/require-safety-comment-for-type-assertion, ziggy/no-unsafe-dictionary-type -- The integration fixture supplies the minimal Pi context and open serialized tool parameter shape. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- The Pi tool executor is the tested error boundary. */
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  createEventBus,
  discoverAndLoadExtensions,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const packageRoot = join(import.meta.dir, "..");

const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const fixtures: string[] = [];

const bridgeChannel = "ziggy:computer-use:browser-bridge:v1";

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

test("persists browser storage from a headed named profile into a background relaunch", async () => {
  if (process.platform !== "darwin") return;
  await access(chromeExecutable);
  const fixture = await mkdtemp(join(tmpdir(), "ziggy-browser-profile-"));
  fixtures.push(fixture);
  const eventBus = createEventBus();
  const loaded = await discoverAndLoadExtensions([packageRoot], packageRoot, fixture, eventBus);
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0];
  const ctx = { cwd: fixture } as unknown as ExtensionContext;

  const execute = async (
    name: string,
    params: Record<string, unknown>,
  ): Promise<AgentToolResult<unknown>> => {
    const definition = extension?.tools.get(name)?.definition as ToolDefinition | undefined;

    if (!definition) throw new Error(`Missing tool '${name}'.`);

    return await definition.execute(`test-${name}`, params, undefined, undefined, ctx);
  };

  const request = async (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
    await new Promise((resolve, reject) => {
      let accepted = false;

      const timer = setTimeout(
        () => reject(new Error("Browser bridge test request timed out.")),
        10_000,
      );

      eventBus.emit(bridgeChannel, {
        version: 1,
        requestId: crypto.randomUUID(),
        ctx,
        ...input,
        accept: () => {
          accepted = true;
        },
        reply: (response: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(response);
        },
      });

      if (!accepted) {
        clearTimeout(timer);
        reject(new Error("Browser bridge test request was not accepted."));
      }
    });

  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        "<!doctype html><title>Profile proof</title><main>ready <button onclick=\"localStorage.setItem('clicked', 'yes')\">Save</button></main>",
        {
          headers: { "content-type": "text/html" },
        },
      ),
  });

  const url = `http://127.0.0.1:${server.port}/`;

  try {
    const headed = await execute("launch_browser", {
      url,
      profile: "persist-test",
      mode: "headed",
    });

    const profilePath = join(fixture, ".runtime", "computer-use", "browsers", "persist-test");
    expect((await stat(profilePath)).mode & 0o777).toBe(0o700);
    const headedState = (headed.details as { stateId?: string } | undefined)?.stateId;
    expect(headedState).toBeString();

    const refusedLease = await request({
      operation: "acquire",
      profile: "job-test",
      mode: "background",
      url,
    });

    expect(refusedLease).toMatchObject({ ok: false, error: { code: "browser-busy" } });
    const roots = await execute("find_roots", { kind: "browser_page" });

    const browserRoot = (
      roots.details as { windows?: Array<{ windowRef?: string; url?: string }> } | undefined
    )?.windows?.find((window) => window.url === url)?.windowRef;

    expect(browserRoot).toBeString();
    const observed = await execute("observe_ui", { root: browserRoot, mode: "semantic" });
    const observedState = (observed.details as { stateId?: string } | undefined)?.stateId;
    expect(observedState).toBeString();

    const ready = await execute("wait_for", {
      stateId: observedState,
      text: "Save",
      until: "present",
      timeoutMs: 5_000,
    });

    const readyState = (ready.details as { stateId?: string } | undefined)?.stateId;
    expect(readyState).toBeString();

    const missing = await execute("search_ui", {
      stateId: readyState,
      text: "definitely-not-on-this-page",
    });

    expect((missing.details as { totalMatches?: number } | undefined)?.totalMatches).toBe(0);
    const found = await execute("search_ui", { stateId: readyState, text: "Save" });

    const saveRef = (found.details as { matches?: Array<{ ref?: string }> } | undefined)
      ?.matches?.[0]?.ref;

    expect(saveRef).toBeString();

    const acted = await execute("act_ui", {
      stateId: readyState,
      actions: [{ action: "click", ref: saveRef }],
    });

    const actedState = (acted.details as { stateId?: string } | undefined)?.stateId;
    expect(actedState).toBeString();
    await execute("evaluate_browser", {
      stateId: actedState,
      expression:
        "(() => { if (localStorage.getItem('clicked') !== 'yes') throw new Error('browser click did not run'); document.cookie = 'ziggy_cookie=kept; Max-Age=3600; SameSite=Lax'; localStorage.setItem('ziggy-storage', 'kept'); return true; })()",
    });
    await execute("close_browser", { profile: "persist-test" });

    const background = await execute("launch_browser", {
      url,
      profile: "persist-test",
      mode: "background",
    });

    const backgroundState = (background.details as { stateId?: string } | undefined)?.stateId;
    expect(backgroundState).toBeString();

    const persisted = await execute("evaluate_browser", {
      stateId: backgroundState,
      expression: "({ cookie: document.cookie, storage: localStorage.getItem('ziggy-storage') })",
    });

    const rendered = persisted.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");

    expect(rendered).toContain("ziggy_cookie=kept");
    expect(rendered).toContain('"storage":"kept"');
    await execute("close_browser", { profile: "persist-test" });

    const acquired = await request({
      operation: "acquire",
      profile: "job-test",
      mode: "background",
      url,
    });

    expect(acquired).toMatchObject({ ok: true, operation: "acquire" });
    const token = acquired.token;
    expect(token).toBeString();
    await expect(execute("find_roots", { kind: "browser_page" })).rejects.toThrow(
      "exclusive browser workflow",
    );

    const leaseReady = await request({
      operation: "wait",
      token,
      text: "Save",
      until: "present",
      timeoutMs: 5_000,
    });

    expect(leaseReady).toMatchObject({ ok: true, found: true });

    const leaseValue = await request({
      operation: "evaluate",
      token,
      expression: "({ page: document.title, count: 0 })",
    });

    expect(leaseValue).toMatchObject({
      ok: true,
      value: { page: "Profile proof", count: 0 },
    });
    const navigated = await request({ operation: "navigate", token, url: `${url}?page=2` });
    expect(navigated).toMatchObject({ ok: true, operation: "navigate" });
    const released = await request({ operation: "release", token });
    expect(released).toMatchObject({ ok: true, released: true });
    const releasedAgain = await request({ operation: "release", token });
    expect(releasedAgain).toMatchObject({ ok: true, released: false });

    const abortAcquire = await request({
      operation: "acquire",
      profile: "abort-test",
      mode: "background",
      url,
    });

    const abortToken = abortAcquire.token;
    expect(abortToken).toBeString();
    const abortController = new AbortController();

    const abortedWait = request({
      operation: "wait",
      token: abortToken,
      text: "never-going-to-appear",
      until: "present",
      timeoutMs: 60_000,
      signal: abortController.signal,
    });

    setTimeout(() => abortController.abort(), 50);
    expect(await abortedWait).toMatchObject({ ok: false, error: { code: "aborted" } });

    const afterAbort = await execute("launch_browser", {
      url,
      profile: "after-abort",
      mode: "background",
    });

    expect((afterAbort.details as { stateId?: string } | undefined)?.stateId).toBeString();
    await execute("close_browser", { profile: "after-abort" });

    const lockDir = join(fixture, ".runtime", "computer-use", "browsers", ".locks", "busy-test");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    await expect(
      execute("launch_browser", { url, profile: "busy-test", mode: "background" }),
    ).rejects.toThrow("busy or has a stale ownership lock");
  } finally {
    await execute("close_browser", {});
    server.stop(true);
  }
}, 60_000);
