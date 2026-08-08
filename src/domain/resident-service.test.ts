import { describe, expect, test } from "bun:test";
import { deriveResidentServiceIdentity, residentServiceFingerprint } from "./resident-service";

describe("resident service identity", () => {
  test("is stable, bounded, and Profile-path scoped", () => {
    const first = deriveResidentServiceIdentity("/Users/example/work/a/profile");
    const again = deriveResidentServiceIdentity("/Users/example/work/a/profile");
    const sameNameElsewhere = deriveResidentServiceIdentity("/Users/example/work/b/profile");

    expect(again).toEqual(first);
    expect(sameNameElsewhere.readableName).toBe(first.readableName);
    expect(sameNameElsewhere.pathDigest).not.toBe(first.pathDigest);
    expect(first).toEqual({
      key: `profile-${first.pathDigest}`,
      readableName: "profile",
      pathDigest: residentServiceFingerprint("/Users/example/work/a/profile").slice(0, 12),
      launchdLabel: `works.earendil.ziggy.serve.profile.${first.pathDigest}`,
      systemdUnit: `ziggy-serve-profile-${first.pathDigest}.service`,
    });
  });

  test("normalizes hostile or unreadable basenames without producing an unbounded identity", () => {
    const identity = deriveResidentServiceIdentity(`/tmp/${"A weird Profile ! ".repeat(10)}`);
    const fallback = deriveResidentServiceIdentity("/tmp/💫");

    expect(identity.readableName.length).toBeLessThanOrEqual(32);
    expect(identity.readableName).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(fallback.readableName).toBe("profile");
  });
});
