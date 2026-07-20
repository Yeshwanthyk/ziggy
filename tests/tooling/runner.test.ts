import { describe, expect, test } from "bun:test";
import { declaredGates, manifestStatusLines } from "../../tooling/verification/runner.ts";
import type { VerificationManifest } from "../../tooling/verification/manifests.ts";

const s0: VerificationManifest = {
  schemaVersion: 1,
  stage: "s0",
  status: "implemented",
  predecessors: [],
  scenarios: [],
  gates: ["typecheck", "test"],
  requirements: [],
};

const s1: VerificationManifest = {
  schemaVersion: 1,
  stage: "s1",
  status: "implemented",
  predecessors: ["s0"],
  scenarios: [],
  gates: ["lint", "typecheck"],
  requirements: [],
};

const emptyS2: VerificationManifest = {
  schemaVersion: 1,
  stage: "s2",
  status: "manifest-empty",
  predecessors: ["s0", "s1"],
  scenarios: [],
  gates: [],
  requirements: [],
};

describe("verification runner manifest planning", () => {
  test("dispatches only manifest-selected gates in declaration order", () => {
    expect(declaredGates([s0, s1])).toEqual(["typecheck", "test", "lint"]);
  });

  test("reports selected manifest-empty stages explicitly", () => {
    expect(manifestStatusLines([s0, emptyS2])).toEqual([
      "s2: manifest-empty (not implemented; no behavior claimed)",
    ]);
    expect(manifestStatusLines([s0])).toEqual([]);
  });
});
