import { describe, expect, test } from "bun:test";
import {
  deriveResidentServiceIdentity,
  residentServiceFingerprint,
} from "ziggy/domain/resident-service";

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
    const fallback = deriveResidentServiceIdentity("/tmp/💫");

    expect(fallback.readableName).toBe("profile");
  });
});
