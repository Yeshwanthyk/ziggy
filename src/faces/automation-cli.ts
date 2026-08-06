import type { AutomationRunOutcome } from "../domain/automation";

export interface AutomationCliResult {
  readonly exitCode: 0 | 1;
  readonly stderr: ReadonlyArray<string>;
}

export const renderAutomationOutcome = (outcome: AutomationRunOutcome): AutomationCliResult => {
  if (outcome.kind === "declined") {
    return { exitCode: 0, stderr: [`wake declined: gate exited ${outcome.exitCode}`] };
  }
  if (outcome.delivery.kind === "resolution-failed") {
    return {
      exitCode: 1,
      stderr: [`wake delivery resolution failed: ${outcome.delivery.category}`],
    };
  }
  const stderr = [
    `wake delivery resolved: ${outcome.delivery.targets.length} targets`,
    ...outcome.delivery.targets.map((target) =>
      target.status === "delivered"
        ? `wake delivered: ${target.target}`
        : `wake delivery failed: ${target.target} (${target.category}, ${target.retriable ? "retriable" : "not retriable"})`,
    ),
  ];
  return {
    exitCode: outcome.delivery.targets.some((target) => target.status === "failed") ? 1 : 0,
    stderr,
  };
};
