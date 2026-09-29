import { expect, test } from "bun:test";
import fc from "fast-check";
import { residentReady } from "ziggy/application/resident-service";

test("restart waits for a fresh owner matching the supervisor process", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100_000 }),
      fc.integer({ min: 1, max: 100_000 }),
      fc.string({ maxLength: 24 }),
      fc.boolean(),
      (oldPid, nextPid, acquiredAt, supervisorHasPid) => {
        const previous = { _tag: "running" as const, path: "/profile", pid: oldPid, acquiredAt };
        const newOwner = { ...previous, pid: nextPid, acquiredAt: `${acquiredAt}-new` };

        const supervisor = supervisorHasPid
          ? { state: "running" as const, pid: nextPid }
          : { state: "running" as const };

        expect(residentReady(supervisor, previous, previous, "running")).toBe(false);
        expect(residentReady(supervisor, newOwner, previous, "running")).toBe(true);
        expect(
          residentReady({ state: "running", pid: oldPid }, newOwner, previous, "running"),
        ).toBe(oldPid === nextPid);
        expect(
          residentReady(supervisor, previous, { _tag: "stopped", path: "/profile" }, "running"),
        ).toBe(!supervisorHasPid || nextPid === oldPid);
        expect(residentReady({ state: "stopped" }, newOwner, previous, "running")).toBe(false);
        expect(
          residentReady(
            { state: "stopped" },
            { _tag: "stopped", path: "/profile" },
            previous,
            "stopped",
          ),
        ).toBe(true);
      },
    ),
    { numRuns: 100 },
  );
});
