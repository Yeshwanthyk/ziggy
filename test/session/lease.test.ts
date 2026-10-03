import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "effect";
import { isSessionHeld, takeSessionLease } from "ziggy/session/index";
import { makeSessionLeaseSet } from "ziggy/session/lease";

const roots: Array<string> = [];

const profile = () => {
  const root = mkdtempSync(join(tmpdir(), "ziggy-lease-"));
  roots.push(root);

  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a held transcript refuses a second writer with the holder's pid until released", () => {
  const root = profile();
  expect(Result.getOrThrow(isSessionHeld(root, "one"))).toBe(false);

  const lease = Result.getOrThrow(takeSessionLease(root, "one"));
  expect(Result.getOrThrow(isSessionHeld(root, "one"))).toBe(true);

  const competing = takeSessionLease(root, "one");
  expect(competing).toMatchObject({
    failure: { _tag: "SessionHeld", pid: process.pid },
  });

  lease.release();
  expect(Result.getOrThrow(isSessionHeld(root, "one"))).toBe(false);
  Result.getOrThrow(takeSessionLease(root, "one")).release();
});

test("a lease set keeps only the transcript Pi landed on", () => {
  const root = profile();
  const leases = makeSessionLeaseSet(root);

  Result.getOrThrow(leases.hold("from"));
  Result.getOrThrow(leases.hold("to"));
  Result.getOrThrow(leases.hold("to"));
  leases.keepOnly("to");

  expect(Result.getOrThrow(isSessionHeld(root, "from"))).toBe(false);
  expect(Result.getOrThrow(isSessionHeld(root, "to"))).toBe(true);

  leases.keepOnly(undefined);
  expect(Result.getOrThrow(isSessionHeld(root, "to"))).toBe(false);
});
