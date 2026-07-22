import { expect, test } from "bun:test";
import { scenarioRegistry } from "./registry.ts";

test("S0 scenario declarations are stable and executable test files", async () => {
  expect(scenarioRegistry.map((scenario) => scenario.id)).toEqual([
    "s0.boundary-testkit",
    "s0.compile-smoke-flags",
    "s0.package-graph",
    "s0.verification-integrity",
    "s0.world-contract",
    "s1.protocol",
    "s1.filesystem-world",
    "s1.agent-loop",
    "s1.memory",
    "s1.integrated-waist",
    "s2.daemon-kernel",
    "s2.attach-socket",
    "s2.service-lifecycle",
    "s2.operator-readiness",
    "s3.attach-client",
    "s3.stable-main",
    "s3.cli-ask",
    "s3.cli-sessions-list",
    "s3.compiled-daemon-lifecycle",
    "s3.compiled-cli-process",
    "s3.credential-authority",
    "s3.provider-auth",
    "s3.profile-config",
    "s3.profile-initialization",
    "s3.tui-protocol-face",
    "s4.manifest-version-compatibility",
  ]);

  for (const scenario of scenarioRegistry) {
    expect(await Bun.file(scenario.file).exists()).toBe(true);
  }
});
