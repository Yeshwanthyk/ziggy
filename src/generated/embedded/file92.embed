/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi extension callbacks are the package filesystem boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Pi tools return bounded, stable boundary errors. */
/* oxlint-disable ziggy-effect/no-promise-catch -- Observer cleanup is intentionally best effort. */
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendReviewLog,
  decodeSessionEntries,
  observeCompletedForegroundSession,
  readStatus,
  writeCuratorExtension,
  type ExtensionWriteInput,
  type ReviewLogInput,
} from "./src/manager.ts";

const ErrorMessage = Type.Object({ message: Type.String() }, { additionalProperties: true });

const jsonResult = <T>(payload: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const errorResult = (cause: unknown) =>
  jsonResult({
    ok: false,
    error: Check(ErrorMessage, cause) ? cause.message : String(cause),
  });

const logParameters = Type.Object({
  decision: Type.Union([
    Type.Literal("applied"),
    Type.Literal("no-op"),
    Type.Literal("staged"),
    Type.Literal("error"),
  ]),
  detail: Type.String({ minLength: 1, maxLength: 2_000 }),
  evidence: Type.Optional(Type.String({ maxLength: 500 })),
  clearReady: Type.Optional(Type.Boolean()),
});

const writeParameters = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  body: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
  replace: Type.Optional(Type.Boolean()),
  expectedOldSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
});

export default function selfImprovement(pi: ExtensionAPI): void {
  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.isIdle()) return;
    void observeCompletedForegroundSession({
      profilePath: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      entries: decodeSessionEntries(ctx.sessionManager.getEntries()),
    }).catch(() => undefined);
  });

  pi.registerTool({
    name: "self_improvement_status",
    label: "self_improvement_status",
    description: "Show bounded Curator observation state and whether a review is ready.",
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, _parameters, _signal, _onUpdate, ctx) {
      try {
        return jsonResult(await readStatus(ctx.cwd));
      } catch (cause) {
        return errorResult(cause);
      }
    },
  });

  pi.registerTool({
    name: "self_improvement_log",
    label: "self_improvement_log",
    description: "Append one bounded, reviewable Curator decision and optionally clear readiness.",
    parameters: logParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const logInput: ReviewLogInput = {
          decision: parameters.decision,
          detail: parameters.detail,
        };
        if (parameters.evidence !== undefined) {
          logInput.evidence = parameters.evidence;
        }
        if (parameters.clearReady !== undefined) {
          logInput.clearReady = parameters.clearReady;
        }
        const result = await appendReviewLog(ctx.cwd, logInput);
        return jsonResult({ ok: true, ...result });
      } catch (cause) {
        return errorResult(cause);
      }
    },
  });

  pi.registerTool({
    name: "self_improvement_extension_write",
    label: "self_improvement_extension_write",
    description:
      "Create a real Profile-local skill-only package, or replace the skill in one visibly Curator-managed package.",
    parameters: writeParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      try {
        const writeInput: ExtensionWriteInput = {
          id: parameters.id,
          body: parameters.body,
        };
        if (parameters.replace !== undefined) {
          writeInput.replace = parameters.replace;
        }
        if (parameters.expectedOldSha256 !== undefined) {
          writeInput.expectedOldSha256 = parameters.expectedOldSha256;
        }
        return jsonResult(await writeCuratorExtension(ctx.cwd, writeInput));
      } catch (cause) {
        return errorResult(cause);
      }
    },
  });
}
