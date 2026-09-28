/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import {
  acquireSessionLease,
  makeSessionLeaseTransitions,
  sessionLeasePath,
} from "ziggy/adapters/pi/session-lease";
import type { LeaseWorkerFixture } from "./fixtures/session-lease-worker";

const fixture: LeaseWorkerFixture = join(import.meta.dir, "fixtures", "session-lease-worker.ts");

const makeProfile = () => mkdtemp(join(tmpdir(), "ziggy-session-lease-"));

const worker = (profile: string, session: string, duration: number) =>
  Bun.spawn({
    cmd: [process.execPath, fixture, profile, session, String(duration)],
    stdout: "pipe",
    stderr: "pipe",
  });

test("release is idempotent and an old holder cannot remove a replacement projection", async () => {
  const profile = await makeProfile();

  try {
    const old = await Effect.runPromise(
      acquireSessionLease(profile, "session", { pid: 111, ownerId: () => "old" }),
    );

    await Effect.runPromise(old);

    const replacement = await Effect.runPromise(
      acquireSessionLease(profile, "session", { pid: 222, ownerId: () => "new" }),
    );

    await Effect.runPromise(old);

    const projection = JSON.parse(
      await readFile(`${sessionLeasePath(profile, "session")}.owner`, "utf8"),
    );

    expect(projection).toEqual({ ownerId: "new", pid: 222 });
    expect(
      Exit.isFailure(await Effect.runPromiseExit(acquireSessionLease(profile, "session"))),
    ).toBe(true);
    await Effect.runPromise(replacement);
    await Effect.runPromise(replacement);
    const next = await Effect.runPromise(acquireSessionLease(profile, "session"));
    await Effect.runPromise(next);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("independent Bun processes race for one session; exactly one wins", async () => {
  const profile = await makeProfile();
  const children = Array.from({ length: 6 }, () => worker(profile, "race", 1200));

  try {
    const outputs = await Promise.all(
      children.map(async (child) => ({
        output: (await new Response(child.stdout).text()).trim(),
        exit: await child.exited,
      })),
    );

    expect(outputs.filter((item) => item.output === "won" && item.exit === 0)).toHaveLength(1);
    expect(outputs.filter((item) => item.output === "held" && item.exit === 0)).toHaveLength(5);
  } finally {
    for (const child of children) child.kill();
    await rm(profile, { recursive: true, force: true });
  }
});

test("killing a real holder frees its SQLite lease regardless of recorded pid", async () => {
  const profile = await makeProfile();
  const child = worker(profile, "crash", 10000);

  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("won");
    child.kill("SIGKILL");
    await child.exited;
    const release = await Effect.runPromise(acquireSessionLease(profile, "crash"));
    await Effect.runPromise(release);
  } finally {
    child.kill();
    await rm(profile, { recursive: true, force: true });
  }
});

test("session replacement reserves destination before releasing previous id", async () => {
  const profile = await makeProfile();

  try {
    const first = await Effect.runPromise(acquireSessionLease(profile, "first"));
    const transitions = makeSessionLeaseTransitions(profile, "first", first);
    const competing = await Effect.runPromise(acquireSessionLease(profile, "second"));
    expect(Exit.isFailure(await Effect.runPromiseExit(transitions.reserve("second")))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(acquireSessionLease(profile, "first")))).toBe(
      true,
    );
    await Effect.runPromise(competing);
    await Effect.runPromise(transitions.reserve("second"));
    expect(
      Exit.isFailure(await Effect.runPromiseExit(acquireSessionLease(profile, "second"))),
    ).toBe(true);
    await Effect.runPromise(transitions.transition("second"));
    expect(transitions.owns("second")).toBe(true);
    const old = await Effect.runPromise(acquireSessionLease(profile, "first"));
    await Effect.runPromise(old);
    await Effect.runPromise(transitions.close);
    await Effect.runPromise(transitions.close);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
