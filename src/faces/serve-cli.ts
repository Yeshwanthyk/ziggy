import { Result } from "effect";
import type {
  ResidentLifecycleResult,
  ResidentLogsResult,
  ResidentServiceStatus,
} from "../application/resident-service";
import type { AutomationRunProjection, AutomationStatusProjection } from "../domain/automation";
import type { GatewayOwnerStatus } from "../domain/gateway";
import type { DiscordHealthProjection } from "../domain/discord-health";
import type { SlackHealthProjection } from "../domain/slack-health";

const bounded = (value: string): string =>
  [
    ...value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  ]
    .slice(0, 160)
    .join("");

const processLines = (status: GatewayOwnerStatus): ReadonlyArray<string> =>
  status._tag === "stopped"
    ? ["process: stopped", "pid: -", "acquired at: -"]
    : [`process: ${status._tag}`, `pid: ${status.pid}`, `acquired at: ${status.acquiredAt}`];

const runSummary = (run: AutomationRunProjection): string =>
  `${run.runId} ${run.automationId} ${run.state} ${run.trigger} ${new Date(run.recordedAtMs).toISOString()}`;

const schedulerLines = (status: AutomationStatusProjection): ReadonlyArray<string> => {
  const heartbeat = status.heartbeatAtMs;
  const scheduler =
    heartbeat === null || heartbeat > status.observedAtMs
      ? "unknown"
      : status.observedAtMs - heartbeat <= 90_000
        ? "active"
        : "stale";
  const tick =
    status.lastTickStatus === null || status.lastTickAtMs === null
      ? "unknown"
      : `${status.lastTickStatus} (${new Date(status.lastTickAtMs).toISOString()}${status.lastTickError === null ? "" : `; ${bounded(status.lastTickError)}`})`;
  const next = status.schedules
    .filter((row) => row.definitionState === "valid" && row.nextScheduledAtMs !== null)
    .sort(
      (left, right) =>
        (left.nextScheduledAtMs ?? 0) - (right.nextScheduledAtMs ?? 0) ||
        left.automationId.localeCompare(right.automationId),
    )[0];
  return [
    `scheduler: ${scheduler}`,
    `tick: ${tick}`,
    `next due: ${next?.nextScheduledAtMs == null ? "none" : `${new Date(next.nextScheduledAtMs).toISOString()} (${next.automationId})`}`,
    `active runs: ${status.activeRunCount}`,
    `latest run: ${status.latestRun === null ? "none" : runSummary(status.latestRun)}`,
  ];
};

const slackLines = (projection: SlackHealthProjection) => {
  if (projection._tag === "not-configured") {
    return { lines: ["slack: not configured"], degraded: false };
  }
  if (projection._tag === "not-observed") {
    return { lines: ["slack: not observed"], degraded: true };
  }
  const { snapshot } = projection;
  const stale =
    snapshot.updatedAtMs > projection.observedAtMs ||
    projection.observedAtMs - snapshot.updatedAtMs > 90_000;
  return {
    lines: [
      `slack: ${stale ? "stale" : snapshot.state}`,
      `slack observed: ${new Date(snapshot.updatedAtMs).toISOString()}`,
      `slack turns: active ${snapshot.activeTurnCount}, queued ${snapshot.queuedTurnCount}, completed ${snapshot.completedTurnCount}, cancelled ${snapshot.cancelledTurnCount}, failed ${snapshot.failedTurnCount}`,
      `slack last failure: ${snapshot.lastFailure ?? "none"}`,
    ],
    degraded: stale || snapshot.state !== "connected",
  };
};

const discordLines = (projection: DiscordHealthProjection) => {
  if (projection._tag === "not-configured") {
    return { lines: ["discord: not configured"], degraded: false };
  }
  if (projection._tag === "not-observed") {
    return { lines: ["discord: not observed"], degraded: true };
  }
  const { snapshot } = projection;
  const stale =
    snapshot.updatedAtMs > projection.observedAtMs ||
    projection.observedAtMs - snapshot.updatedAtMs > 90_000;
  return {
    lines: [
      `discord: ${stale ? "stale" : snapshot.state}`,
      `discord observed: ${new Date(snapshot.updatedAtMs).toISOString()}`,
      `discord turns: active ${snapshot.activeTurnCount}, queued ${snapshot.queuedTurnCount}, completed ${snapshot.completedTurnCount}, cancelled ${snapshot.cancelledTurnCount}, failed ${snapshot.failedTurnCount}`,
      `discord last failure: ${snapshot.lastFailure ?? "none"}`,
    ],
    degraded: stale || snapshot.state !== "connected",
  };
};

export interface RenderedServeStatus {
  readonly text: string;
  readonly exitCode: 0 | 1;
}

export const renderServeStatus = (status: ResidentServiceStatus): RenderedServeStatus => {
  let degraded = false;
  const managed = Result.match(status.managed, {
    onFailure: (failure) => {
      degraded = true;
      return `unknown (${bounded(failure.message)})`;
    },
    onSuccess: (state) => {
      if (state._tag === "current") return "installed";
      if (state._tag === "not-installed") return "not-installed";
      if (state._tag === "drifted") {
        degraded = true;
        return "drifted";
      }
      degraded = true;
      return `unknown (${state.reason})`;
    },
  });
  const supervisor = Result.match(status.supervisor, {
    onFailure: (failure) => {
      degraded = true;
      return `unknown (${bounded(failure.message)})`;
    },
    onSuccess: (value) => {
      if (value.state === "unknown") degraded = true;
      return value.state === "running" || value.reason === undefined
        ? value.state
        : `${value.state} (${bounded(value.reason)})`;
    },
  });
  const process = Result.match(status.process, {
    onFailure: (failure) => {
      degraded = true;
      return [`process: unknown (${bounded(failure.message)})`, "pid: -", "acquired at: -"];
    },
    onSuccess: (value) => {
      if (value._tag === "stale") degraded = true;
      return processLines(value);
    },
  });
  const scheduler = Result.match(status.scheduler, {
    onFailure: (failure) => {
      degraded = true;
      return [
        `scheduler: unknown (${bounded(failure.message)})`,
        "tick: unknown",
        "next due: unknown",
        "active runs: unknown",
        "latest run: unknown",
      ];
    },
    onSuccess: schedulerLines,
  });
  if (scheduler[0]?.startsWith("scheduler: unknown") || scheduler[0] === "scheduler: stale") {
    degraded = true;
  }
  const discord = Result.match(status.discord, {
    onFailure: (failure) => ({
      lines: [`discord: unknown (${bounded(failure.message)})`],
      degraded: true,
    }),
    onSuccess: discordLines,
  });
  if (discord.degraded) degraded = true;
  const slack = Result.match(status.slack, {
    onFailure: (failure) => ({
      lines: [`slack: unknown (${bounded(failure.message)})`],
      degraded: true,
    }),
    onSuccess: slackLines,
  });
  if (slack.degraded) degraded = true;

  return {
    text: [
      `profile: ${status.profilePath}`,
      `managed service: ${managed}`,
      `service manager: ${status.manager}`,
      `supervisor: ${supervisor}`,
      ...process,
      ...scheduler,
      ...discord.lines,
      ...slack.lines,
    ].join("\n"),
    exitCode: degraded ? 1 : 0,
  };
};

export const renderResidentLifecycle = (result: ResidentLifecycleResult): string => {
  const lines = [
    `${result.action}: ${result.identity}`,
    `service manager: ${result.manager}`,
    `definition: ${result.definitionPath}`,
  ];
  if (result.write !== undefined) lines.push(`definition state: ${result.write}`);
  if (result.removed !== undefined)
    lines.push(`definition removed: ${result.removed ? "yes" : "no"}`);
  if (result.ready !== undefined)
    lines.push(`readiness: ${result.ready ? "ready" : "not-reached"}`);
  if (result.owner !== undefined) lines.push(...processLines(result.owner));
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
};

export const renderResidentLogs = (result: ResidentLogsResult): string =>
  [result.stdout.replace(/\s+$/u, ""), result.stderr.replace(/\s+$/u, "")]
    .filter((value) => value.length > 0)
    .join("\n");
