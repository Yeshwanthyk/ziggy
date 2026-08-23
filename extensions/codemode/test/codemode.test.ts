/* oxlint-disable ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion -- The fake Pi adapter narrows the registered generic tool for an end-to-end extension test. */
/* oxlint-disable ziggy-effect/no-effect-execution-boundary, ziggy-effect/no-native-promise-ownership, ziggy-effect/no-json-parse, ziggy-effect/no-promise-catch, ziggy-effect/no-try-catch-or-throw -- Tests are approved Effect and fixture execution edges. */
/* oxlint-disable ziggy/no-conditional-empty-object-spread, ziggy/no-chained-type-assertions, ziggy/no-unknown-parameters, ziggy/no-unknown-returns -- The fake generic Pi API is narrowed to the one registered tool contract under test. */
import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import codeMode, { createCodeModeSession, executeCodeMode } from "../index.ts";

const fixturePath = join(import.meta.dirname, "fixtures", "mcp-server.ts");
const roots: string[] = [];

const processIds = async (marker: string): Promise<ReadonlyArray<number>> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const contents = await Bun.file(marker)
      .text()
      .catch(() => "");
    const ids = contents
      .split("\n")
      .filter((line) => line.startsWith("start:"))
      .map((line) => Number(line.slice("start:".length)))
      .filter(Number.isSafeInteger);
    if (ids.length >= 2) return ids;
    await Bun.sleep(10);
  }
  return [];
};

const expectProcessesGone = async (ids: ReadonlyArray<number>): Promise<void> => {
  expect(ids.length).toBeGreaterThanOrEqual(2);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const alive = ids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return;
    await Bun.sleep(10);
  }
  for (const pid of ids) expect(() => process.kill(pid, 0)).toThrow();
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const profile = async (
  options: {
    readonly limits?: Record<string, number>;
    readonly mode?: string;
    readonly marker?: string;
    readonly allowTools?: ReadonlyArray<string>;
  } = {},
) => {
  const root = await mkdtemp(join("/tmp", "ziggy-codemode-test-"));
  roots.push(root);
  await writeFile(
    join(root, "codemode.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fixturePath],
          allowTools: options.allowTools ?? ["echo", "slow", "fail", "secretStatus"],
          env: {
            CODEMODE_SECRET: "host-only-secret",
            ...(options.mode === undefined ? {} : { MCP_MODE: options.mode }),
            ...(options.marker === undefined ? {} : { MCP_MARKER: options.marker }),
          },
        },
      },
      limits: options.limits,
    }),
  );
  return root;
};

describe("codemode extension", () => {
  test("loads and invokes a package copy outside the repository through Pi", async () => {
    const root = await mkdtemp(join("/tmp", "ziggy-codemode-installed-profile-"));
    const copyRoot = await mkdtemp(join("/tmp", "ziggy-codemode-installed-copy-"));
    roots.push(root, copyRoot);
    await writeFile(join(root, "SOUL.md"), "installed copy smoke\n");
    await writeFile(join(root, "codemode.json"), '{"mcpServers":{}}');
    const installed = join(copyRoot, "codemode");
    await cp(join(import.meta.dirname, ".."), installed, { recursive: true });
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dirname, "profile-smoke.ts"),
        root,
        installed,
        "return { copied: true };",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr, result: JSON.parse(stdout) }).toEqual({
      exitCode: 0,
      stderr: "",
      result: {
        ok: true,
        value: { copied: true },
        logs: [],
        toolCalls: [],
        durationMs: expect.any(Number),
        truncated: false,
      },
    });
  });

  test("registers one collision-resistant Pi tool and composes native MCP calls", async () => {
    const root = await profile();
    type CapturedTool = {
      readonly name: string;
      readonly execute: (
        id: string,
        input: { readonly code: string },
        signal: AbortSignal | undefined,
        update: undefined,
        context: { readonly cwd: string },
      ) => Promise<{ readonly details: unknown }>;
    };
    let registered: CapturedTool | undefined;
    let shutdown: (() => Promise<void> | void) | undefined;
    const fakePi = {
      registerTool: (tool: unknown) => {
        registered = tool as unknown as CapturedTool;
      },
      on: (event: string, handler: () => unknown) => {
        if (event === "session_shutdown") shutdown = async () => void (await handler());
      },
    } as unknown as Pick<ExtensionAPI, "on" | "registerTool">;
    codeMode(fakePi);

    expect(registered?.name).toBe("codemode_execute");
    const tool = registered as CapturedTool;
    const response = await tool.execute(
      "call-1",
      {
        code: `
          const matches = await tools.$codemode.search({ query: "echo" });
          console.log(matches[0].path);
          const echoed = await tools.fixture.echo({ value: "hello" });
          return { match: matches[0].path, echoed: echoed.structuredContent };
        `,
      },
      undefined,
      undefined,
      { cwd: root },
    );
    expect(response.details).toMatchObject({
      ok: true,
      value: { match: "fixture.echo", echoed: { value: "hello" } },
      logs: ["[log] fixture.echo"],
      toolCalls: [{ path: "$codemode.search" }, { path: "fixture.echo" }],
    });
    await shutdown?.();
  });

  test("does not start MCP until code searches or calls a tool", async () => {
    const root = await profile({ marker: join("/tmp", `codemode-marker-${crypto.randomUUID()}`) });
    const config = JSON.parse(await readFile(join(root, "codemode.json"), "utf8"));
    const marker = config.mcpServers.fixture.env.MCP_MARKER;
    const session = createCodeModeSession();
    expect(await Effect.runPromise(executeCodeMode(session, root, "return 7;"))).toMatchObject({
      ok: true,
      value: 7,
    });
    expect(await Bun.file(marker).exists()).toBe(false);
    await Effect.runPromise(session.close());
  });

  test("keeps credentials host-only and exposes only declared MCP tools", async () => {
    const root = await profile();
    const session = createCodeModeSession();
    const secret = await Effect.runPromise(
      executeCodeMode(session, root, "return await tools.fixture.secretStatus({});"),
    );
    const ambient = await Effect.runPromise(executeCodeMode(session, root, "return process.env;"));
    const piTool = await Effect.runPromise(
      executeCodeMode(session, root, "return tools.read({});"),
    );
    expect(secret).toMatchObject({ ok: true, value: { structuredContent: { present: true } } });
    expect(ambient).toMatchObject({ ok: false, error: { kind: "UnknownIdentifier" } });
    expect(piTool).toMatchObject({ ok: false, error: { kind: "UnknownTool" } });
    expect(JSON.stringify([secret, ambient, piTool])).not.toContain("host-only-secret");
    await Effect.runPromise(session.close());
  });

  test("hides and rejects discovered tools absent from the explicit allowlist", async () => {
    const root = await profile({ allowTools: ["echo"] });
    const session = createCodeModeSession();
    const catalog = await Effect.runPromise(
      executeCodeMode(session, root, 'return await tools.$codemode.search({ query: "" });'),
    );
    const denied = await Effect.runPromise(
      executeCodeMode(session, root, "return await tools.fixture.secretStatus({});"),
    );
    expect(catalog).toMatchObject({
      ok: true,
      value: [{ path: "fixture.echo" }],
    });
    expect(JSON.stringify(catalog)).not.toContain("secretStatus");
    expect(denied).toMatchObject({ ok: false, error: { kind: "ToolFailure" } });
    await Effect.runPromise(session.close());
  });

  test("fails MCP isError, malformed protocol, repeated cursors, and duplicate names closed", async () => {
    const scenarios = [
      { mode: undefined, code: "return await tools.fixture.fail({});", kind: "ToolFailure" },
      { mode: "malformed", code: "return await tools.$codemode.search({});", kind: "ToolFailure" },
      {
        mode: "repeat-cursor",
        code: "return await tools.$codemode.search({});",
        kind: "ToolFailure",
      },
      { mode: "duplicate", code: "return await tools.$codemode.search({});", kind: "ToolFailure" },
    ];
    for (const scenario of scenarios) {
      const root = await profile(scenario.mode === undefined ? {} : { mode: scenario.mode });
      const session = createCodeModeSession();
      const result = await Effect.runPromise(executeCodeMode(session, root, scenario.code));
      expect(result).toMatchObject({ ok: false, error: { kind: scenario.kind } });
      expect(result).not.toHaveProperty("error.line");
      await Effect.runPromise(session.close());
    }
  });

  test("enforces tool, step, wall, log, and result bounds", async () => {
    const root = await profile({
      limits: { timeoutMs: 80, maxSteps: 100, maxToolCalls: 1, maxOutputBytes: 256 },
    });
    const session = createCodeModeSession();
    const calls = await Effect.runPromise(
      executeCodeMode(
        session,
        root,
        "await tools.fixture.echo({}); return await tools.fixture.echo({});",
      ),
    );
    const steps = await Effect.runPromise(executeCodeMode(session, root, "while (true) {}"));
    const timeout = await Effect.runPromise(
      executeCodeMode(session, root, "return await tools.fixture.slow({});"),
    );
    const outputRoot = await profile({
      limits: { timeoutMs: 1_000, maxSteps: 5_000, maxToolCalls: 1, maxOutputBytes: 256 },
    });
    const outputSession = createCodeModeSession();
    const output = await Effect.runPromise(
      executeCodeMode(
        outputSession,
        outputRoot,
        'let result = []; let i = 0; while (i < 100) { console.log(""); result.push("xxxxxxxx"); i = i + 1; } return result;',
      ),
    );
    expect(calls).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } });
    expect(steps).toMatchObject({ ok: false, error: { kind: "StepLimitExceeded" } });
    expect(timeout).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
    expect(output).toMatchObject({ ok: true, truncated: true });
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThanOrEqual(256);
    await Effect.runPromise(session.close());
    await Effect.runPromise(outputSession.close());
  });

  test("external cancellation interrupts an in-flight MCP call", async () => {
    const marker = join("/tmp", `codemode-cancel-${crypto.randomUUID()}`);
    const root = await profile({ marker, mode: "ignore-term", limits: { timeoutMs: 5_000 } });
    const session = createCodeModeSession();
    const controller = new AbortController();
    const started = performance.now();
    const execution = Effect.runPromise(
      executeCodeMode(session, root, "return await tools.fixture.slow({});"),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await expect(execution).rejects.toBeDefined();
    expect(performance.now() - started).toBeLessThan(1_000);
    await expectProcessesGone(await processIds(marker));
    await Effect.runPromise(session.close());
  });

  test("timeout revokes a TERM-ignoring MCP process group", async () => {
    const marker = join("/tmp", `codemode-timeout-revoke-${crypto.randomUUID()}`);
    const root = await profile({ marker, mode: "ignore-term", limits: { timeoutMs: 60 } });
    const session = createCodeModeSession();
    const result = await Effect.runPromise(
      executeCodeMode(session, root, "return await tools.fixture.slow({});"),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } });
    await expectProcessesGone(await processIds(marker));
    await Effect.runPromise(session.close());
  });

  test("session shutdown awaits cleanup of a TERM-ignoring MCP descendant", async () => {
    const marker = join("/tmp", `codemode-shutdown-revoke-${crypto.randomUUID()}`);
    const root = await profile({
      marker,
      mode: "descendant-ignore-term",
      limits: { timeoutMs: 2_000 },
    });
    const session = createCodeModeSession();
    const result = await Effect.runPromise(
      executeCodeMode(session, root, 'return await tools.$codemode.search({ query: "" });'),
    );
    expect(result).toMatchObject({ ok: true });
    const ids = await processIds(marker);
    await Effect.runPromise(session.close());
    await expectProcessesGone(ids);
  });

  test("normalizes adversarial AST and helper defects into result envelopes", async () => {
    const root = await profile();
    const session = createCodeModeSession();
    const probes = [
      "return ({ constructor: 1 });",
      "return ({ __proto__: 1 });",
      "return [,,];",
      "const f = ({ value }) => value; return f({ value: 1 });",
      'return import("node:fs");',
      'return eval("1");',
      "return globalThis;",
    ];
    for (const code of probes) {
      const result = await Effect.runPromise(executeCodeMode(session, root, code));
      expect(result).toMatchObject({ ok: false, error: { kind: expect.any(String) } });
    }
    await Effect.runPromise(session.close());
  });

  test("bounds a late adversarial failure after calls and logs", async () => {
    const root = await profile({
      limits: { timeoutMs: 2_000, maxToolCalls: 20, maxOutputBytes: 256 },
    });
    const session = createCodeModeSession();
    const result = await Effect.runPromise(
      executeCodeMode(
        session,
        root,
        `
          let i = 0;
          while (i < 10) {
            await tools.fixture.echo({ index: i });
            console.log("completed-call", i);
            i = i + 1;
          }
          return ({ constructor: 1 });
        `,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "ExecutionFailure" },
      truncated: true,
    });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(256);
    await Effect.runPromise(session.close());
  });

  test("schema-decodes Profile config before spawning", async () => {
    const root = await mkdtemp(join("/tmp", "ziggy-codemode-invalid-"));
    roots.push(root);
    await writeFile(join(root, "codemode.json"), '{"mcpServers":{"bad.name":{"command":7}}}');
    const result = await Effect.runPromise(
      executeCodeMode(createCodeModeSession(), root, "return 1;"),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "CodeModeConfigError" } });
  });

  test("rejects a symlinked codemode.json", async () => {
    const root = await mkdtemp(join("/tmp", "ziggy-codemode-symlink-"));
    roots.push(root);
    const target = join(root, "actual.json");
    await writeFile(target, '{"mcpServers":{}}');
    await symlink(target, join(root, "codemode.json"));
    const result = await Effect.runPromise(
      executeCodeMode(createCodeModeSession(), root, "return 1;"),
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "CodeModeConfigError" } });
  });
});
