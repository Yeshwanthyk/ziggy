import { Context, Effect, Layer } from "effect";
import { ProfileExtensions } from "./profile-extensions";
import type { BundledCopyState, DoctorCheck, DoctorReport } from "../domain/doctor";
import type { SlackHealthProjection } from "../domain/slack-health";
import type { DiscordHealthProjection } from "../domain/discord-health";
import type { ProfileAgent } from "../domain/profile";
import type { ProfileExtensionsApi } from "../domain/profile-extension";
import { type AuthApi, Auth, type ModelsApi, Models, type ProfileTarget } from "../profile";

export interface DoctorApi {
  readonly check: (target: ProfileTarget) => Effect.Effect<DoctorReport>;
}

export class Doctor extends Context.Service<Doctor, DoctorApi>()("ziggy/Doctor") {}

/** Adapter-owned probes, composed only after the application has chosen its capabilities. */
export interface DoctorChecksApi {
  readonly check: (
    target: ProfileTarget,
    auth: AuthApi,
    models: ModelsApi,
    profileExtensions: ProfileExtensionsApi,
  ) => Effect.Effect<DoctorReport>;
}

export class DoctorChecks extends Context.Service<DoctorChecks, DoctorChecksApi>()(
  "ziggy/DoctorChecks",
) {}

export const makeDoctor = (
  auth: AuthApi,
  models: ModelsApi,
  profileExtensions: ProfileExtensionsApi,
  checks: DoctorChecksApi,
): DoctorApi => ({
  check: (target) => checks.check(target, auth, models, profileExtensions),
});

export const DoctorLive = Layer.effect(
  Doctor,
  Effect.gen(function* () {
    return makeDoctor(yield* Auth, yield* Models, yield* ProfileExtensions, yield* DoctorChecks);
  }),
);

export const ok = (id: string, message: string): DoctorCheck => ({ id, severity: "ok", message });

export const warn = (id: string, message: string): DoctorCheck => ({
  id,
  severity: "warn",
  message,
});

export const error = (id: string, message: string): DoctorCheck => ({
  id,
  severity: "error",
  message,
});

export const classifySlackRuntime = (projection: SlackHealthProjection): DoctorCheck => {
  if (projection._tag === "not-configured") {
    return ok("slack-runtime", "Slack is not configured");
  }

  if (projection._tag === "not-observed") {
    return warn("slack-runtime", "Slack is configured but has no runtime observation");
  }

  const { snapshot } = projection;

  const stale =
    snapshot.updatedAtMs > projection.observedAtMs ||
    projection.observedAtMs - snapshot.updatedAtMs > 90_000;

  if (stale) return warn("slack-runtime", "Slack runtime observation is stale");

  if (snapshot.state === "connected") {
    return ok(
      "slack-runtime",
      `Slack is connected; ${snapshot.activeTurnCount} active and ${snapshot.queuedTurnCount} queued turn${snapshot.queuedTurnCount === 1 ? "" : "s"}`,
    );
  }

  if (snapshot.state === "failed") {
    return error("slack-runtime", `Slack runtime failed (${snapshot.lastFailure ?? "unknown"})`);
  }

  return warn("slack-runtime", `Slack runtime is ${snapshot.state}`);
};

export const classifyDiscordRuntime = (projection: DiscordHealthProjection): DoctorCheck => {
  if (projection._tag === "not-configured") {
    return ok("discord-runtime", "Discord is not configured");
  }

  if (projection._tag === "not-observed") {
    return warn("discord-runtime", "Discord is configured but has no runtime observation");
  }

  const { snapshot } = projection;

  const stale =
    snapshot.updatedAtMs > projection.observedAtMs ||
    projection.observedAtMs - snapshot.updatedAtMs > 90_000;

  if (stale) return warn("discord-runtime", "Discord runtime observation is stale");

  if (snapshot.state === "connected") {
    return ok(
      "discord-runtime",
      `Discord is connected; ${snapshot.activeTurnCount} active and ${snapshot.queuedTurnCount} queued turn${snapshot.queuedTurnCount === 1 ? "" : "s"}`,
    );
  }

  if (snapshot.state === "failed") {
    return error(
      "discord-runtime",
      `Discord runtime failed (${snapshot.lastFailure ?? "unknown"})`,
    );
  }

  return warn("discord-runtime", `Discord runtime is ${snapshot.state}`);
};

/** Recovery text is Profile policy; the adapter only determines the copy state. */
export const bundledCopyCheck = (
  profilePath: string,
  id: string,
  state: BundledCopyState,
): DoctorCheck | undefined => {
  if (state === "modified")
    return warn(
      "resources",
      `${id} has local changes; copy your edits elsewhere and restore the original files, then run ziggy extensions update ${JSON.stringify(profilePath)} ${id}`,
    );

  if (state === "untracked-behind")
    return warn(
      "resources",
      `${id} is behind the bundle and untracked; run ziggy extensions update ${JSON.stringify(profilePath)} ${id} --adopt`,
    );

  return undefined;
};

export const modelDoctorCheck = (
  status: Effect.Success<ReturnType<ModelsApi["status"]>>,
): DoctorCheck =>
  status.providerId === undefined || status.modelId === undefined
    ? error("model", "No effective Pi model is selected")
    : ok(
        "model",
        `Pi model settings resolve to ${status.providerId}/${status.modelId} (${status.thinking})`,
      );

export const authDoctorCheck = (
  providerId: string | undefined,
  providers: Effect.Success<ReturnType<AuthApi["status"]>>,
): DoctorCheck => {
  if (providerId === undefined)
    return warn("auth", "Provider auth cannot be checked until a model is selected");

  const provider = providers.find((candidate) => candidate.id === providerId);

  return provider?.configured === undefined
    ? error("auth", `Provider ${providerId} is not authenticated`)
    : ok("auth", `Provider ${providerId} authentication is configured`);
};

export const agentsDoctorCheck = (
  agents: ReadonlyArray<ProfileAgent>,
  known: Effect.Success<ReturnType<ModelsApi["list"]>>,
): DoctorCheck => {
  for (const agent of agents) {
    if (agent.provider === undefined || agent.model === undefined) continue;

    const model = known.find(
      (candidate) => candidate.providerId === agent.provider && candidate.modelId === agent.model,
    );

    if (model === undefined)
      return error("agents", `Profile agent ${agent.id} selects an unknown Pi model`);

    if (agent.thinking !== undefined && !model.thinkingLevels.includes(agent.thinking))
      return error(
        "agents",
        `Profile agent ${agent.id} selects unsupported thinking ${agent.thinking}`,
      );
  }

  return ok("agents", `${agents.length} Profile agent file${agents.length === 1 ? "" : "s"} valid`);
};
