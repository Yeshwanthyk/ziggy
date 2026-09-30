import { join } from "node:path";
import { Clock, Context, Effect, Layer, Match, Option, Predicate, Result } from "effect";
import { liveAutomationGate, type AutomationGate } from "../adapters/bun/automation-gate";
import {
  automationRunStore,
  makeLiveManualRunId,
  type AutomationRunStore,
  type RunTerminal,
} from "../adapters/bun/automation-sqlite";
import { automationFileStore, type AutomationFileStore } from "../adapters/fs/automation-files";
import { appendStoredAutomationResult } from "../adapters/pi/automation-result";
import {
  type Automation,
  AutomationDatabaseError,
  AutomationFileSystemError,
  AutomationGateFailed,
  AutomationInvalid,
  AutomationNotFound,
  AutomationPaused,
  AutomationScheduleSuperseded,
  automationScheduleFingerprint,
  type AutomationRunOutcome,
  type AutomationTrigger,
  type AutomationTarget,
  type AutomationTargetOutcome,
  decodeBroadcastsFileJson,
  parseAutomationFile,
  parseAutomationTarget,
  scheduledRunId,
  validateAutomationId,
} from "../domain/automation";
import type { ProfileSpecialistError } from "../domain/agent";
import { ZiggyAgent, type OpenSession, type ZiggyAgentApi } from "./agent";
import type { Deliver, DeliveryFailure } from "./delivery";
import { deliverDiscord } from "./discord-gateway";
import { deliverTelegram } from "./gateway";
import { deliverSlack } from "./slack-gateway";
import { type ProfileTarget } from "../profile";
import type { LiveSessionsApi } from "../resident/live-sessions";

export type AutomationError =
  | AutomationInvalid
  | AutomationNotFound
  | AutomationPaused
  | AutomationScheduleSuperseded
  | AutomationFileSystemError
  | AutomationGateFailed
  | AutomationDatabaseError
  | ProfileSpecialistError;

export interface AutomationsApi {
  readonly run: (
    target: ProfileTarget,
    automationId: string,
    trigger: AutomationTrigger,
    context?: AutomationInvocationContext,
  ) => Effect.Effect<AutomationRunOutcome, AutomationError>;
}

export interface AutomationInvocationContext {
  /** Conversation results for an open session go through its handle, so watchers see them. */
  readonly live?: LiveSessionsApi;
}

export class Automations extends Context.Service<Automations, AutomationsApi>()(
  "ziggy/Automations",
) {}

export interface AutomationCapabilities {
  readonly gate: AutomationGate;
  readonly files: AutomationFileStore;
  readonly printReply: (reply: string) => Effect.Effect<void>;
  readonly appendStoredResult: typeof appendStoredAutomationResult;
  readonly deliver: Deliver;
}

/** Each gateway owns its config, chunking and send. */
const deliverToGateway: Deliver = (profile, target, text) =>
  Match.valueTags(target, {
    telegram: (telegram) => deliverTelegram(profile, telegram, text),
    discord: (discord) => deliverDiscord(profile, discord, text),
    slack: (slack) => deliverSlack(profile, slack, text),
  });

const liveCapabilities: AutomationCapabilities = {
  gate: liveAutomationGate,
  files: automationFileStore,
  printReply: (reply) => Effect.sync(() => console.log(reply)),
  appendStoredResult: appendStoredAutomationResult,
  deliver: deliverToGateway,
};

const readAutomation = (
  files: AutomationFileStore,
  target: ProfileTarget,
  idSource: string,
  allowPaused: boolean,
) =>
  Effect.gen(function* () {
    const id = yield* validateAutomationId(idSource);
    const loaded = yield* files.readDefinition(target, id, allowPaused);

    return yield* parseAutomationFile(id, loaded.path, loaded.source);
  });

type TargetResolution =
  | { readonly ok: true; readonly targets: ReadonlyArray<AutomationTarget> }
  | {
      readonly ok: false;
      readonly category: "broadcasts-unreadable" | "broadcasts-invalid" | "all-empty";
    };

const resolveTargets = (
  files: AutomationFileStore,
  target: ProfileTarget,
  automation: Automation,
): Effect.Effect<TargetResolution> =>
  Effect.gen(function* () {
    let homes: ReadonlyArray<AutomationTarget> | undefined;

    if (automation.broadcast.includes("all")) {
      const path = join(target.path, "broadcasts.json");
      const sourceResult = yield* files.readBroadcasts(target).pipe(Effect.result);

      if (Result.isFailure(sourceResult)) {
        return { ok: false, category: "broadcasts-unreadable" };
      }

      const source = sourceResult.success ?? '{"targets":[]}';
      const decoded = yield* decodeBroadcastsFileJson(source).pipe(Effect.option);

      if (Option.isNone(decoded)) return { ok: false, category: "broadcasts-invalid" };
      const parsed: Array<AutomationTarget> = [];

      for (const value of decoded.value.targets) {
        const item = yield* parseAutomationTarget(automation.id, path, value).pipe(Effect.option);

        if (Option.isNone(item)) return { ok: false, category: "broadcasts-invalid" };
        parsed.push(item.value);
      }

      homes = parsed;

      if (homes.length === 0) return { ok: false, category: "all-empty" };
    }

    const resolved: Array<AutomationTarget> = [];
    const seen = new Set<string>();

    for (const token of automation.broadcast) {
      const additions =
        token === "origin"
          ? automation.origin === undefined
            ? []
            : [automation.origin]
          : token === "all"
            ? (homes ?? [])
            : [token];

      for (const addition of additions) {
        if (!seen.has(addition.target)) {
          seen.add(addition.target);
          resolved.push(addition);
        }
      }
    }

    return { ok: true, targets: resolved };
  });

const deliver = (
  capabilities: AutomationCapabilities,
  profile: ProfileTarget,
  target: AutomationTarget,
  reply: string,
  automationId: string,
  runId: string,
  timestamp: string,
  context?: AutomationInvocationContext,
): Effect.Effect<AutomationTargetOutcome> => {
  const operation: Effect.Effect<void, DeliveryFailure> = Effect.gen(function* () {
    if (Predicate.isTagged("conversation")(target)) {
      const result = {
        automationId,
        runId,
        targetSessionId: target.sessionId,
        text: reply,
        timestamp,
      };

      const stored = capabilities.appendStoredResult(profile.path, result);

      const owner =
        context?.live === undefined
          ? undefined
          : yield* context.live
              .findBySessionId(result.targetSessionId)
              .pipe(
                Effect.mapError(
                  (): DeliveryFailure => ({ category: "owner-unavailable", retriable: true }),
                ),
              );

      return yield* (
        owner === undefined
          ? stored
          : owner.handle.appendAutomationResult(result).pipe(
              // The owner switched transcripts or lost its lease; the target is now stored.
              Effect.catchIf(
                (failure) =>
                  failure.category === "destination-missing" || failure.category === "session-held",
                () => stored,
              ),
              Effect.asVoid,
            )
      ).pipe(
        Effect.mapError(
          (failure): DeliveryFailure => ({
            category: failure.category,
            retriable: failure.retriable,
          }),
        ),
      );
    }

    return yield* capabilities.deliver(profile, target, reply);
  });

  return operation.pipe(
    Effect.as<AutomationTargetOutcome>({ target: target.target, status: "delivered" }),
    Effect.catch((failure) =>
      Effect.succeed({ target: target.target, status: "failed", ...failure } as const),
    ),
  );
};

// oxfmt-ignore
export interface AutomationRunRuntime { readonly store: AutomationRunStore; readonly now: Effect.Effect<number>; readonly makeManualRunId: () => string }

const liveRunRuntime: AutomationRunRuntime = {
  store: automationRunStore,
  now: Clock.currentTimeMillis,
  makeManualRunId: makeLiveManualRunId,
};

interface TerminalIntent {
  readonly outcome: AutomationRunOutcome;
  readonly terminal: Omit<RunTerminal, "atMs">;
  readonly targets: ReadonlyArray<AutomationTargetOutcome>;
}

const gateFailureCategory = (
  reason: AutomationGateFailed["reason"],
): "AutomationGateFailed:spawn" | "AutomationGateFailed:wait" | "AutomationGateFailed:timeout" => {
  switch (reason) {
    case "spawn":
      return "AutomationGateFailed:spawn";
    case "wait":
      return "AutomationGateFailed:wait";
    case "timeout":
      return "AutomationGateFailed:timeout";
  }
};

// oxfmt-ignore
const failedCategory = (error: AutomationError): NonNullable<RunTerminal["failureCategory"]> => Match.value(error).pipe(Match.tagsExhaustive({ AutomationInvalid: () => "AutomationInvalid" as const, AutomationNotFound: () => "AutomationNotFound" as const, AutomationPaused: () => "AutomationPaused" as const, AutomationScheduleSuperseded: () => "schedule-superseded" as const, AutomationFileSystemError: () => "AutomationFileSystemError" as const, AutomationGateFailed: (failure) => gateFailureCategory(failure.reason), AutomationDatabaseError: () => "AutomationDatabaseError" as const, ProfileNotInitialized: () => "ProfileNotInitialized" as const, ProviderConfigError: () => "ProviderConfigError" as const, SessionHeld: () => "session-held" as const, SessionBusy: () => "SessionBusy" as const, ProviderCallError: () => "ProviderCallError" as const, ProfileExtensionInvalid: () => "ProfileExtensionInvalid" as const, ProfileFileSystemError: () => "ProfileFileSystemError" as const, ExtensionLoadFailed: () => "ExtensionLoadFailed" as const, ProfileAgentInvalid: () => "ProfileAgentInvalid" as const, ProfileAgentMentionInvalid: () => "ProfileAgentMentionInvalid" as const, SpecialistAgentNotFound: () => "SpecialistAgentNotFound" as const, SpecialistProviderUnsupported: () => "SpecialistProviderUnsupported" as const, SpecialistModelUnsupported: () => "SpecialistModelUnsupported" as const, SpecialistAuthUnavailable: () => "SpecialistAuthUnavailable" as const, SpecialistThinkingUnsupported: () => "SpecialistThinkingUnsupported" as const, SpecialistToolUnsupported: () => "SpecialistToolUnsupported" as const, SpecialistRunFailed: () => "SpecialistRunFailed" as const }))

const chatModelOverride = (automation: Automation): Pick<OpenSession, "model"> => {
  if (automation.provider !== undefined && automation.model !== undefined) {
    return {
      model:
        automation.thinking === undefined
          ? { provider: automation.provider, model: automation.model }
          : {
              provider: automation.provider,
              model: automation.model,
              thinking: automation.thinking,
            },
    };
  }

  return automation.thinking === undefined ? {} : { model: { thinking: automation.thinking } };
};

export const makeAutomations = (
  agent: ZiggyAgentApi,
  capabilities: AutomationCapabilities = liveCapabilities,
  runtime: AutomationRunRuntime = liveRunRuntime,
): AutomationsApi => ({
  run: (target, automationIdSource, trigger, context) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const automationId = yield* validateAutomationId(automationIdSource);
        const admittedAt = yield* runtime.now;

        const runId =
          trigger.kind === "manual-force"
            ? runtime.makeManualRunId()
            : scheduledRunId(automationId, Date.parse(trigger.scheduledFor));

        const fingerprint = trigger.kind === "scheduled" ? trigger.scheduleFingerprint : null;

        const owner =
          trigger.kind === "scheduled"
            ? { kind: "resident" as const, id: trigger.residentOwnerId }
            : undefined;

        if (trigger.kind === "manual-force")
          yield* restore(runtime.store.recover(target.path, admittedAt));

        // A manual claim must not be stranded by interruption before start. Scheduled claims
        // have already committed with the cursor; both paths enter the same terminal guard.
        const admitted = yield* Effect.gen(function* () {
          if (trigger.kind === "manual-force") {
            const admission = yield* runtime.store.admitManual(
              target.path,
              automationId,
              runId,
              admittedAt,
            );

            if (admission === "skipped-busy") return false;
          }

          yield* runtime.store
            .start(target.path, runId, yield* runtime.now, fingerprint, owner)
            .pipe(
              Effect.catch((failure) =>
                trigger.kind === "manual-force"
                  ? Effect.flatMap(runtime.now, (atMs) =>
                      runtime.store.failClaim(target.path, runId, atMs),
                    ).pipe(Effect.andThen(Effect.fail(failure)))
                  : Effect.fail(failure),
              ),
            );

          return true;
        });

        if (!admitted) return { kind: "skipped-busy" };

        const finish = (
          terminal: Omit<RunTerminal, "atMs">,
          targets: ReadonlyArray<AutomationTargetOutcome> = [],
        ) =>
          Effect.flatMap(runtime.now, (atMs) =>
            runtime.store.finish(target.path, runId, { ...terminal, atMs }, targets, owner),
          );

        const execute: Effect.Effect<TerminalIntent, AutomationError> = Effect.gen(function* () {
          const automation = yield* readAutomation(
            capabilities.files,
            target,
            automationId,
            trigger.kind === "scheduled",
          );

          if (
            trigger.kind === "scheduled" &&
            automationScheduleFingerprint(automation) !== trigger.scheduleFingerprint
          ) {
            return yield* new AutomationScheduleSuperseded({
              id: automation.id,
              message: `scheduled automation ${automation.id} changed after its occurrence was claimed`,
            });
          }

          if (trigger.kind === "scheduled" && automation.gate === undefined) {
            return {
              outcome: { kind: "declined", reason: "gate-nonzero", exitCode: 1 },
              terminal: {
                state: "skipped-gate",
                localCompleted: false,
                failureCategory: "gate-missing",
                gateExitCode: null,
              },
              targets: [],
            };
          }

          if (automation.gate !== undefined) {
            const gate = yield* capabilities.gate.run(target.path, automation.id, automation.gate);

            if (gate.kind === "declined") {
              return {
                outcome: { kind: "declined", reason: "gate-nonzero", exitCode: gate.exitCode },
                terminal: {
                  state: "skipped-gate",
                  localCompleted: false,
                  failureCategory: "gate-nonzero",
                  gateExitCode: gate.exitCode,
                },
                targets: [],
              };
            }
          }

          const reply =
            automation.specialist === undefined
              ? yield* Effect.acquireUseRelease(
                  agent.open({
                    target,
                    context: { kind: "local" },
                    directory: join(target.path, "sessions", "automations", automation.id),
                    session: "new",
                    name: `Automation · ${automation.id}`,
                    ...chatModelOverride(automation),
                  }),
                  (handle) => handle.prompt(automation.prompt),
                  (handle) =>
                    handle.dispose.pipe(
                      Effect.catch((failure) =>
                        Effect.sync(() =>
                          console.error(
                            `[wake] ${automation.id}: session dispose failed — ${failure.message}`,
                          ),
                        ),
                      ),
                    ),
                )
              : (yield* agent.runSpecialist(
                  target,
                  automation.specialist.agentId,
                  automation.specialist.task,
                  {
                    sessionDirectory: join(
                      target.path,
                      "sessions",
                      "automations",
                      automation.id,
                      runId,
                    ),
                  },
                )).answer;

          yield* capabilities.printReply(reply);
          const resolution = yield* resolveTargets(capabilities.files, target, automation);

          if (!resolution.ok) {
            return {
              outcome: {
                kind: "executed",
                delivery: { kind: "resolution-failed", category: resolution.category },
              },
              terminal: {
                state: "failed",
                localCompleted: true,
                failureCategory: resolution.category,
                gateExitCode: null,
              },
              targets: [],
            };
          }

          const outcomes: Array<AutomationTargetOutcome> = [];

          for (const destination of resolution.targets) {
            const deliveredAt = new Date(yield* runtime.now).toISOString();
            outcomes.push(
              yield* deliver(
                capabilities,
                target,
                destination,
                reply,
                automation.id,
                runId,
                deliveredAt,
                context,
              ),
            );
          }

          const firstFailure = outcomes.find((outcome) => outcome.status === "failed");

          return {
            outcome: { kind: "executed", delivery: { kind: "resolved", targets: outcomes } },
            terminal:
              firstFailure === undefined
                ? {
                    state: "completed",
                    localCompleted: true,
                    failureCategory: null,
                    gateExitCode: null,
                  }
                : {
                    state: "failed",
                    localCompleted: true,
                    failureCategory: firstFailure.category,
                    gateExitCode: null,
                  },
            targets: outcomes,
          };
        });

        return yield* restore(execute).pipe(
          Effect.catch((error) =>
            finish({
              state: "failed",
              localCompleted: false,
              failureCategory: failedCategory(error),
              gateExitCode: null,
            }).pipe(Effect.andThen(Effect.fail(error))),
          ),
          Effect.flatMap((intent) =>
            finish(intent.terminal, intent.targets).pipe(Effect.as(intent.outcome)),
          ),
          Effect.onInterrupt(() =>
            finish({
              state: "failed",
              localCompleted: false,
              failureCategory: "interrupted",
              gateExitCode: null,
            }),
          ),
        );
      }),
    ),
});

export const AutomationsLive = Layer.effect(
  Automations,
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;

    return makeAutomations(agent);
  }),
);
