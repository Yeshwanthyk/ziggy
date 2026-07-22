export interface ScenarioDeclaration {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly stage: "s0" | "s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "s7";
  readonly file: string;
  readonly seed: string;
  readonly schedule: string;
  readonly boundaryConfiguration: string;
}

export const scenarioRegistry: ReadonlyArray<ScenarioDeclaration> = [
  {
    schemaVersion: 1,
    id: "s0.boundary-testkit",
    stage: "s0",
    file: "tests/testkit/boundaries.test.ts",
    seed: "s0-boundary-v1",
    schedule: "serial-controlled-boundaries",
    boundaryConfiguration: "fixed-clock-sequence-ids-fault-plan-command-recorder",
  },
  {
    schemaVersion: 1,
    id: "s0.compile-smoke-flags",
    stage: "s0",
    file: "tests/tooling/compile-smoke.test.ts",
    seed: "s0-compile-v1",
    schedule: "controlled-process-runner",
    boundaryConfiguration: "isolated-temp-process-timeout",
  },
  {
    schemaVersion: 1,
    id: "s0.package-graph",
    stage: "s0",
    file: "tests/tooling/package-graph.test.ts",
    seed: "s0-package-graph-v1",
    schedule: "static-fixture-mutations",
    boundaryConfiguration: "typescript-ast-repository-graph",
  },
  {
    schemaVersion: 1,
    id: "s0.verification-integrity",
    stage: "s0",
    file: "tests/tooling/verification.test.ts",
    seed: "s0-verification-v1",
    schedule: "isolated-artifact-publication",
    boundaryConfiguration: "synthetic-evidence-and-replay-inputs",
  },
  {
    schemaVersion: 1,
    id: "s0.world-contract",
    stage: "s0",
    file: "tests/testkit/world/world-contract.test.ts",
    seed: "s0-world-v1",
    schedule: "required-memory-commit-cut-points",
    boundaryConfiguration: "fixed-clock-in-memory-semantic-world",
  },
  {
    schemaVersion: 1,
    id: "s1.protocol",
    stage: "s1",
    file: "tests/scenarios/s1-protocol.test.ts",
    seed: "s1-protocol-v1",
    schedule: "serial-canonical-frame-replay",
    boundaryConfiguration: "dependency-free-protocol-fixtures",
  },
  {
    schemaVersion: 1,
    id: "s1.filesystem-world",
    stage: "s1",
    file: "tests/scenarios/s1-filesystem-world.test.ts",
    seed: "s1-filesystem-world-v1",
    schedule: "canonical-session-start-append-then-torn-tail",
    boundaryConfiguration: "fixed-clock-temporary-profile-session-authority-fault",
  },
  {
    schemaVersion: 1,
    id: "s1.agent-loop",
    stage: "s1",
    file: "tests/scenarios/s1-agent-loop.test.ts",
    seed: "s1-agent-loop-v1",
    schedule: "serial-scripted-provider-turn",
    boundaryConfiguration: "fixed-clock-sequence-ids-in-memory-session-world",
  },
  {
    schemaVersion: 1,
    id: "s1.memory",
    stage: "s1",
    file: "tests/scenarios/s1-memory.test.ts",
    seed: "s1-memory-v1",
    schedule: "memory-batches-session-refresh-and-conditional-commit-race",
    boundaryConfiguration: "temporary-profile-memory-commit-observer-and-read-barrier",
  },
  {
    schemaVersion: 1,
    id: "s1.integrated-waist",
    stage: "s1",
    file: "tests/scenarios/s1-integrated-waist.test.ts",
    seed: "s1-integrated-waist-v1",
    schedule: "serial-filesystem-provider-turn-replay",
    boundaryConfiguration: "fixed-clock-temporary-profile-scripted-provider",
  },
  {
    schemaVersion: 1,
    id: "s2.daemon-kernel",
    stage: "s2",
    file: "tests/core/daemon-kernel.test.ts",
    seed: "s2-daemon-kernel-v1",
    schedule: "profile-lock-contention-recovery-and-runtime-shutdown-barriers",
    boundaryConfiguration: "temporary-profile-injected-pid-liveness-and-session-world",
  },
  {
    schemaVersion: 1,
    id: "s2.attach-socket",
    stage: "s2",
    file: "tests/core/daemon-attach-server.test.ts",
    seed: "s2-attach-socket-v1",
    schedule:
      "real-socket-cross-session-provider-barrier-replay-cursor-live-disconnect-approval-and-backpressure-races",
    boundaryConfiguration: "temporary-profile-scripted-provider-socket-peers-and-fiber-barriers",
  },
  {
    schemaVersion: 1,
    id: "s2.service-lifecycle",
    stage: "s2",
    file: "tests/ziggy/service-manager.test.ts",
    seed: "s2-service-lifecycle-v1",
    schedule: "launchd-and-systemd-install-start-stop-status-remove-faults",
    boundaryConfiguration: "in-memory-service-filesystem-and-exact-argv-process-manager",
  },
  {
    schemaVersion: 1,
    id: "s2.operator-readiness",
    stage: "s2",
    file: "tests/ziggy/daemon.test.ts",
    seed: "s2-operator-readiness-v1",
    schedule: "foreground-lifecycle-protocol-probe-autostart-contention-and-doctor",
    boundaryConfiguration: "temporary-profile-real-unix-socket-and-injected-readiness-boundaries",
  },
  {
    schemaVersion: 1,
    id: "s3.attach-client",
    stage: "s3",
    file: "tests/scenarios/s3-attach-client.test.ts",
    seed: "s3-attach-client-v1",
    schedule:
      "real-socket-reverse-correlation-replay-watermark-overflow-post-write-disconnect-and-finalization",
    boundaryConfiguration:
      "shared-scoped-attach-client-real-unix-transport-scripted-protocol-peer-and-fault-barriers",
  },
  {
    schemaVersion: 1,
    id: "s3.stable-main",
    stage: "s3",
    file: "tests/scenarios/s3-stable-main.test.ts",
    seed: "s3-stable-main-v1",
    schedule: "real-socket-concurrent-first-ensure-then-daemon-restart",
    boundaryConfiguration:
      "temporary-profile-fixed-clock-filesystem-session-authority-and-two-socket-clients",
  },
  {
    schemaVersion: 1,
    id: "s3.cli-ask",
    stage: "s3",
    file: "tests/scenarios/s3-cli-ask.test.ts",
    seed: "s3-cli-ask-v1",
    schedule: "missing-daemon-readiness-barrier-accepted-turn-stream-then-post-write-disconnect",
    boundaryConfiguration:
      "temporary-profile-scripted-provider-real-unix-socket-controlled-daemon-start-and-output-sinks",
  },
  {
    schemaVersion: 1,
    id: "s3.cli-sessions-list",
    stage: "s3",
    file: "tests/scenarios/s3-cli-sessions-list.test.ts",
    seed: "s3-cli-sessions-list-v1",
    schedule: "persisted-session-query-in-deterministic-creation-and-id-order",
    boundaryConfiguration:
      "temporary-profile-filesystem-session-authority-scripted-attach-client-and-output-sinks",
  },
  {
    schemaVersion: 1,
    id: "s3.compiled-daemon-lifecycle",
    stage: "s3",
    file: "tests/scenarios/s3-compiled-daemon-lifecycle.test.ts",
    seed: "s3-compiled-daemon-lifecycle-v1",
    schedule: "bounded-doctor-readiness-retries-and-graceful-signal-shutdown",
    boundaryConfiguration:
      "compiled-executable-temporary-profile-real-unix-socket-and-profile-lock",
  },
  {
    schemaVersion: 1,
    id: "s3.compiled-cli-process",
    stage: "s3",
    file: "tests/scenarios/s3-compiled-cli-process.test.ts",
    seed: "s3-compiled-cli-process-v1",
    schedule: "barrier-controlled-absent-to-stale-race-post-write-disconnect-and-sigint-detach",
    boundaryConfiguration:
      "compiled-cli-fixture-production-client-daemon-lifecycle-faux-provider-and-real-unix-sockets",
  },
  {
    schemaVersion: 1,
    id: "s3.credential-authority",
    stage: "s3",
    file: "tests/core/credential-store.test.ts",
    seed: "s3-credentials-v1",
    schedule: "serialized-provider-modify-delete-and-strict-filesystem-preflight",
    boundaryConfiguration: "temporary-profile-private-files-and-secret-canary-absence",
  },
  {
    schemaVersion: 1,
    id: "s3.provider-auth",
    stage: "s3",
    file: "tests/core/daemon-auth.test.ts",
    seed: "s3-provider-auth-v1",
    schedule:
      "injected-models-filesystem-runtime-real-socket-api-key-prompt-oauth-callback-status-and-failure",
    boundaryConfiguration:
      "filesystem-credential-store-injected-models-fake-auth-service-real-attach-socket-and-secret-canary",
  },
  {
    schemaVersion: 1,
    id: "s3.profile-config",
    stage: "s3",
    file: "tests/ziggy/profile-config.test.ts",
    seed: "s3-profile-config-v1",
    schedule: "strict-owner-config-read-and-negative-decode",
    boundaryConfiguration: "temporary-profile-jsonc-without-provider-or-network",
  },
  {
    schemaVersion: 1,
    id: "s3.profile-initialization",
    stage: "s3",
    file: "tests/scenarios/s3-profile-initialization.test.ts",
    seed: "s3-profile-initialization-v1",
    schedule:
      "same-process-exclusive-create-races-child-process-invalid-config-config-preflight-canonical-aliases-and-resumable-faults",
    boundaryConfiguration:
      "temporary-profile-real-filesystem-child-process-race-injected-pre-create-fault-and-compiled-executable",
  },
  {
    schemaVersion: 1,
    id: "s3.tui-protocol-face",
    stage: "s3",
    file: "tests/scenarios/s3-tui-protocol-face.test.ts",
    seed: "s3-tui-protocol-face-v1",
    schedule:
      "production-main-stream-steer-follow-up-interrupt-approval-a-b-a-stale-callback-disconnect-replay-live-overlap-outcome-unknown-and-detach-races",
    boundaryConfiguration:
      "temporary-profile-controlled-providers-real-unix-socket-fault-proxy-shared-attach-client-production-tui-interpreter-and-protocol-only-component",
  },
];
