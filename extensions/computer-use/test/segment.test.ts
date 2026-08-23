/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are explicit Promise boundaries. */
/* oxlint-disable ziggy/no-unsafe-typescript-syntax, ziggy/no-chained-type-assertions, ziggy/require-safety-comment-for-type-assertion -- Test fixtures intentionally construct minimal Pi contexts and malformed boundary input. */
/* oxlint-disable ziggy/no-object-parameters, ziggy/no-unsafe-dictionary-type -- Test spies retain the open serialized Pi executor parameter shape. */
import { describe, expect, test } from "bun:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SEGMENT_MAX_STEPS,
  executeSegment,
  validateSegment,
  type SegmentBridge,
  type SegmentParameters,
} from "../segment.ts";

const ctx = {} as ExtensionContext;
const result = (details: object): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: "fixture" }],
  details,
});

const parameters = (): SegmentParameters => ({
  steps: [
    {
      target: { text: "Save", role: "button", capability: "press" },
      actions: [{ action: "click" }],
      expect: { text: "Saved", until: "present", timeoutMs: 500 },
    },
  ],
});

const bridge = (overrides: Partial<SegmentBridge> = {}): SegmentBridge => ({
  find: async () => result({ totalMatches: 1, windows: [{ windowRef: "@r1" }] }),
  observe: async () => result({ capture: { stateId: "observed" } }),
  search: async () => result({ totalMatches: 1, matches: [{ ref: "@e7" }] }),
  act: async () => result({ capture: { stateId: "acted" }, status: "ok" }),
  wait: async () => result({ stateId: "verified", found: true }),
  ...overrides,
});

describe("semantic segment execution", () => {
  test("passes a read-only assertion without searching or acting", async () => {
    const calls: Array<{ tool: string; parameters: Record<string, unknown> }> = [];
    let searched = false;
    let acted = false;
    const fixture = bridge({
      find: async (_id, input) => {
        calls.push({ tool: "find", parameters: input });
        return result({ totalMatches: 1, windows: [{ windowRef: "@r3" }] });
      },
      observe: async (_id, input) => {
        calls.push({ tool: "observe", parameters: input });
        return result({ capture: { stateId: "assert-observed" } });
      },
      search: async () => {
        searched = true;
        return result({ totalMatches: 1, matches: [{ ref: "@e1" }] });
      },
      act: async () => {
        acted = true;
        return result({ capture: { stateId: "unexpected" }, status: "ok" });
      },
      wait: async (_id, input) => {
        calls.push({ tool: "wait", parameters: input });
        return result({ stateId: "assert-verified", found: true });
      },
    });

    const execution = await executeSegment(
      "segment-assert",
      {
        rootQuery: { app: "Google Chrome", text: "Inbox", kind: "window" },
        steps: [{ assert: { text: "Inbox", until: "present", timeoutMs: 1_000 } }],
      },
      undefined,
      ctx,
      fixture,
    );

    expect(execution.details).toEqual({
      tool: "run_ui_segment",
      status: "completed",
      completed: [
        {
          step: 1,
          stateId: "assert-verified",
          kind: "assert",
          actionCount: 0,
        },
      ],
    });
    expect(calls).toEqual([
      {
        tool: "find",
        parameters: { app: "Google Chrome", text: "Inbox", kind: "window" },
      },
      { tool: "observe", parameters: { root: "@r3", mode: "semantic" } },
      {
        tool: "wait",
        parameters: {
          stateId: "assert-observed",
          text: "Inbox",
          until: "present",
          timeoutMs: 1_000,
        },
      },
    ]);
    expect(searched).toBe(false);
    expect(acted).toBe(false);
  });

  test("fails a read-only assertion without searching or acting", async () => {
    let searched = false;
    let acted = false;
    const fixture = bridge({
      search: async () => {
        searched = true;
        return result({ totalMatches: 1, matches: [{ ref: "@e1" }] });
      },
      act: async () => {
        acted = true;
        return result({ capture: { stateId: "unexpected" }, status: "ok" });
      },
      wait: async () => result({ stateId: "assert-failed", found: false, timedOut: true }),
    });

    await expect(
      executeSegment(
        "segment-assert-failed",
        { root: "@r8", steps: [{ assert: { text: "Signed in", until: "present" } }] },
        undefined,
        ctx,
        fixture,
      ),
    ).rejects.toThrow("assertion was not satisfied");
    expect(searched).toBe(false);
    expect(acted).toBe(false);
  });

  test("resolves a durable root query freshly before every step", async () => {
    const calls: string[] = [];
    let discovery = 0;
    const fixture = bridge({
      find: async (id, input) => {
        calls.push(`find:${id}:${String(input.app)}`);
        discovery += 1;
        return result({ totalMatches: 1, windows: [{ windowRef: `@r${discovery}` }] });
      },
      observe: async (id, input) => {
        calls.push(`observe:${id}:${String(input.root)}`);
        return result({ capture: { stateId: `observed-${discovery}` } });
      },
    });
    const queried = {
      ...parameters(),
      rootQuery: { app: "TextEdit", text: "Document", kind: "window" as const },
      steps: [...parameters().steps, ...parameters().steps],
    };

    const execution = await executeSegment("segment-root-query", queried, undefined, ctx, fixture);

    expect(execution.details).toMatchObject({ status: "completed" });
    expect(calls).toEqual([
      "find:segment-root-query:find:1:TextEdit",
      "observe:segment-root-query:observe:1:@r1",
      "find:segment-root-query:find:2:TextEdit",
      "observe:segment-root-query:observe:2:@r2",
    ]);
  });

  test("fails closed when a durable root query finds no current window", async () => {
    let observed = false;
    const fixture = bridge({
      find: async () => result({ totalMatches: 0, windows: [] }),
      observe: async () => {
        observed = true;
        return result({ capture: { stateId: "unexpected" } });
      },
    });

    await expect(
      executeSegment(
        "segment-root-zero",
        { ...parameters(), rootQuery: { bundleId: "com.apple.TextEdit" } },
        undefined,
        ctx,
        fixture,
      ),
    ).rejects.toThrow("root query did not find a current window");
    expect(observed).toBe(false);
  });

  test("fails closed when a durable root query is ambiguous", async () => {
    let observed = false;
    const fixture = bridge({
      find: async () =>
        result({ totalMatches: 2, windows: [{ windowRef: "@r1" }, { windowRef: "@r2" }] }),
      observe: async () => {
        observed = true;
        return result({ capture: { stateId: "unexpected" } });
      },
    });

    await expect(
      executeSegment(
        "segment-root-ambiguous",
        { ...parameters(), rootQuery: { text: "Document" } },
        undefined,
        ctx,
        fixture,
      ),
    ).rejects.toThrow("root query is ambiguous (2 matches)");
    expect(observed).toBe(false);
  });

  test("resolves a unique target from fresh state and verifies the successor", async () => {
    const calls: Array<{ tool: string; parameters: Record<string, unknown> }> = [];
    const fixture = bridge({
      observe: async (_id, input) => {
        calls.push({ tool: "observe", parameters: input });
        return result({ capture: { stateId: "fresh" } });
      },
      search: async (_id, input) => {
        calls.push({ tool: "search", parameters: input });
        return result({ totalMatches: 1, matches: [{ ref: "@e9" }] });
      },
      act: async (_id, input) => {
        calls.push({ tool: "act", parameters: input });
        return result({ capture: { stateId: "successor" }, status: "ok" });
      },
      wait: async (_id, input) => {
        calls.push({ tool: "wait", parameters: input });
        return result({ stateId: "verified", found: true });
      },
    });

    const execution = await executeSegment("segment-1", parameters(), undefined, ctx, fixture);

    expect(execution.details).toEqual({
      tool: "run_ui_segment",
      status: "completed",
      completed: [{ step: 1, stateId: "verified", ref: "@e9", actionCount: 1 }],
    });
    expect(calls).toEqual([
      { tool: "observe", parameters: { mode: "semantic" } },
      {
        tool: "search",
        parameters: { stateId: "fresh", text: "Save", role: "button", capability: "press" },
      },
      {
        tool: "act",
        parameters: {
          stateId: "fresh",
          actions: [{ action: "click", ref: "@e9" }],
          expect: { text: "Saved", until: "present", timeoutMs: 500 },
        },
      },
      {
        tool: "wait",
        parameters: {
          stateId: "successor",
          text: "Saved",
          until: "present",
          timeoutMs: 500,
        },
      },
    ]);
  });

  test("stops before acting when semantic resolution is ambiguous", async () => {
    let acted = false;
    const fixture = bridge({
      search: async () => result({ totalMatches: 2, matches: [{ ref: "@e1" }, { ref: "@e2" }] }),
      act: async () => {
        acted = true;
        return result({ capture: { stateId: "unexpected" } });
      },
    });

    await expect(
      executeSegment("segment-2", parameters(), undefined, ctx, fixture),
    ).rejects.toThrow("ambiguous (2 matches)");
    expect(acted).toBe(false);
  });

  test("stops after a failed postcondition and does not continue", async () => {
    let observations = 0;
    const fixture = bridge({
      observe: async () => {
        observations += 1;
        return result({ capture: { stateId: `observed-${observations}` } });
      },
      wait: async () => result({ stateId: "failed", found: false, timedOut: true }),
    });
    const twoSteps = { ...parameters(), steps: [...parameters().steps, ...parameters().steps] };

    await expect(executeSegment("segment-3", twoSteps, undefined, ctx, fixture)).rejects.toThrow(
      "postcondition was not satisfied",
    );
    expect(observations).toBe(1);
  });

  test("fails closed when act_ui returns successor state after a swallowed driver failure", async () => {
    let verified = false;
    const fixture = bridge({
      act: async () =>
        result({
          capture: { stateId: "misleading-successor" },
          status: "ok",
          execution: { outcome: "didnt" },
        }),
      wait: async () => {
        verified = true;
        return result({ stateId: "unexpected", found: true });
      },
    });

    await expect(
      executeSegment("segment-failed-act", parameters(), undefined, ctx, fixture),
    ).rejects.toThrow("act_ui outcome was 'didnt'");
    expect(verified).toBe(false);
  });

  test("enforces segment bounds", () => {
    const tooMany = {
      ...parameters(),
      steps: Array.from({ length: SEGMENT_MAX_STEPS + 1 }, () => parameters().steps[0]!),
    };
    expect(() => validateSegment(tooMany)).toThrow(`at most ${SEGMENT_MAX_STEPS} steps`);
    expect(() => validateSegment({ ...parameters(), rootQuery: {} })).toThrow(
      "rootQuery must include",
    );
  });

  test("rejects secret/text values because input actions have no value-bearing operation", () => {
    const unsafe = {
      steps: [
        {
          target: { text: "Password", role: "textbox" },
          actions: [{ action: "setText", text: "hunter2", secret: true }],
          expect: { text: "Password", until: "present" },
        },
      ],
    } as unknown as SegmentParameters;
    expect(() => validateSegment(unsafe)).toThrow("not in the reversible semantic allowlist");
  });

  test("rejects text-producing key arrays but accepts navigation keys and modifier chords", () => {
    const withKeys = (keys: string[]): SegmentParameters => ({
      steps: [
        {
          target: { role: "textbox" },
          actions: [{ action: "keypress", keys }],
          expect: { role: "textbox", until: "present" },
        },
      ],
    });

    expect(() => validateSegment(withKeys(["P", "A", "S", "S"]))).toThrow(
      "text-producing keys are forbidden",
    );
    expect(() => validateSegment(withKeys(["A"]))).toThrow("text-producing keys are forbidden");
    expect(() => validateSegment(withKeys([","]))).toThrow("text-producing keys are forbidden");
    expect(() => validateSegment(withKeys(["ENTER"]))).not.toThrow();
    expect(() => validateSegment(withKeys(["SHIFT", "TAB"]))).not.toThrow();
    expect(() => validateSegment(withKeys(["CMD", "A"]))).not.toThrow();
    expect(() => validateSegment(withKeys(["CTRL", "L"]))).not.toThrow();
  });

  test("propagates cancellation before touching the driver", async () => {
    const controller = new AbortController();
    controller.abort();
    let observed = false;
    const fixture = bridge({
      observe: async () => {
        observed = true;
        return result({ capture: { stateId: "unexpected" } });
      },
    });
    await expect(
      executeSegment("segment-4", parameters(), controller.signal, ctx, fixture),
    ).rejects.toThrow("cancelled");
    expect(observed).toBe(false);
  });
});
