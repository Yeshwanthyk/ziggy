/* eslint-disable ziggy-effect/no-native-promise-ownership -- Bun tests and the fake pi.exec are Promise execution boundaries. */
/* eslint-disable ziggy-effect/no-json-parse -- TypeBox validates deterministic executable output immediately. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- The guard makes failed fixture decoding fail the test. */
/* eslint-disable ziggy-effect/no-error-constructor -- The guard makes failed fixture decoding fail the test. */
import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import registerWebSearch, { runWebSearch } from "../index";

const Output = Type.Object({
  query: Type.String(),
  answer: Type.String(),
  results: Type.Array(
    Type.Object({
      title: Type.String(),
      url: Type.String(),
      highlight: Type.String(),
    }),
  ),
});

test("registers the native web_search tool", () => {
  const names: string[] = [];
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    names.push(tool.name);
  };
  const exec: ExtensionAPI["exec"] = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  });

  registerWebSearch({ exec, registerTool });

  expect(names).toEqual(["web_search"]);
});

test("runs the package-relative helper through pi.exec with the Profile boundary", async () => {
  const profile = "/tmp/web-search-profile";
  const controller = new AbortController();
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string | undefined;
    signal: AbortSignal | undefined;
    timeout: number | undefined;
  }> = [];
  const exec: ExtensionAPI["exec"] = async (command, args, options) => {
    calls.push({
      command,
      args,
      cwd: options?.cwd,
      signal: options?.signal,
      timeout: options?.timeout,
    });
    return { stdout: "{}\n", stderr: "", code: 0, killed: false };
  };

  const result = await runWebSearch({ exec }, ["query"], profile, controller.signal);

  expect(result).toEqual({ stdout: "{}\n", stderr: "", code: 0 });
  expect(calls).toEqual([
    {
      command: process.execPath,
      args: [new URL("../bin/web-search.ts", import.meta.url).pathname, "query"],
      cwd: profile,
      signal: controller.signal,
      timeout: 30_000,
    },
  ]);
});

test("returns deterministic bounded fake-key results without network access", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../bin/web-search.ts", import.meta.url).pathname,
      "effect",
      "boundaries",
      "--n",
      "2",
    ],
    {
      env: { ...process.env, EXA_API_KEY: "fake-test-key" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const parsed: unknown = JSON.parse(stdout);

  expect(exitCode).toBe(0);
  expect(Check(Output, parsed)).toBe(true);
  if (!Check(Output, parsed)) throw new Error("search returned an invalid response");
  expect(parsed).toEqual({
    query: "effect boundaries",
    answer: "(offline) Top result for: effect boundaries",
    results: [
      {
        title: "Result 1 for effect boundaries",
        url: "https://example.com/1",
        highlight: "...",
      },
      {
        title: "Result 2 for effect boundaries",
        url: "https://example.com/2",
        highlight: "...",
      },
    ],
  });
});
