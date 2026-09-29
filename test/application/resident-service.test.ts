import { expect, test } from "bun:test";
import fc from "fast-check";
import { residentReady } from "ziggy/application/resident-service";

test("a restart never accepts the previous resident lease as ready", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100_000 }),
      fc.string({ maxLength: 24 }),
      (pid, acquiredAt) => {
        const previous = { _tag: "running" as const, path: "/profile", pid, acquiredAt };
        expect(residentReady({ state: "running", pid }, previous, previous, "running")).toBe(false);
        expect(
          residentReady(
            { state: "running", pid },
            { ...previous, acquiredAt: `${acquiredAt}-new` },
            previous,
            "running",
          ),
        ).toBe(true);
      },
    ),
    { numRuns: 100 },
  );
});
