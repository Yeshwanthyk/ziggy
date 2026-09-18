/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-promise-catch, ziggy-effect/no-instanceof-error, ziggy/require-readable-spacing -- Pi is the executable extension boundary; contract.ts validates all tool and bridge input before the client. */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJevBridgeHandler, JEV_BRIDGE_CHANNEL } from "./bridge.ts";
import {
  JevFailure,
  createJevClient,
  type JevClient,
  type JevEvaluationOptions,
} from "./client.ts";
import { resolveJevConfig } from "./config.ts";
import { parseEvaluateRequest, type JevEvaluation } from "./contract.ts";

const StructuredContentSchema = Type.Union(
  [
    Type.String(),
    Type.Record(Type.String(), Type.Unknown()),
    Type.Array(Type.Unknown(), { maxItems: 256 }),
    Type.Null(),
  ],
  {
    description: "Text, a JSON object or array, or null.",
    examples: ["Classify this state", { question: "Which team owns this?" }],
  },
);

const ChoiceQuestionSchema = Type.Object(
  {
    type: StringEnum(["choice"] as const),
    instructions: StructuredContentSchema,
    criteria: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), StructuredContentSchema, {
      minProperties: 2,
      maxProperties: 255,
      description: "At least two option labels mapped to descriptions or null.",
    }),
  },
  { additionalProperties: false, description: "Select exactly one option from a fixed set." },
);

const ScoreQuestionSchema = Type.Object(
  {
    type: StringEnum(["score"] as const),
    instructions: StructuredContentSchema,
    criteria: Type.Array(StructuredContentSchema, {
      minItems: 2,
      maxItems: 10,
      description: "Ordered rubric levels from score 0 upward; include at least two.",
    }),
  },
  { additionalProperties: false, description: "Rate state against an ordered rubric." },
);

const NoulQuestionSchema = Type.Object(
  {
    type: StringEnum(["noul"] as const),
    instructions: StructuredContentSchema,
    criteria: Type.Optional(
      Type.Union([
        Type.Object(
          {
            true: Type.Optional(StructuredContentSchema),
            false: Type.Optional(StructuredContentSchema),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
  },
  {
    additionalProperties: false,
    description: "Evaluate a yes/no question and return the probability of yes.",
  },
);

const QuestionSchema = Type.Union([ChoiceQuestionSchema, ScoreQuestionSchema, NoulQuestionSchema], {
  description: "A Choice, Score, or Noul question. Mixed types are allowed.",
});

export const JevEvaluateParameters = Type.Object(
  {
    state: StructuredContentSchema,
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    questions: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), QuestionSchema, {
      minProperties: 1,
      maxProperties: 64,
      description: "Named questions; answer keys match these names.",
    }),
    deadlineMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 120_000 })),
  },
  { additionalProperties: false },
);

const renderEvaluation = (evaluation: JevEvaluation): string => JSON.stringify(evaluation);

export default function registerJev(
  pi: Pick<ExtensionAPI, "events" | "on" | "registerTool">,
): void {
  const clients = new Map<string, Promise<JevClient>>();
  const clientFor = (profilePath: string): Promise<JevClient> => {
    const existing = clients.get(profilePath);
    if (existing) return existing;
    const pending = resolveJevConfig(profilePath)
      .then((config) => createJevClient(config))
      .catch((cause) => {
        clients.delete(profilePath);
        throw new JevFailure(
          cause instanceof Error && cause.message.startsWith("Jev credentials are missing")
            ? "credentials_missing"
            : "config_invalid",
          cause instanceof Error ? cause.message : "Jev configuration is invalid.",
        );
      });
    clients.set(profilePath, pending);
    return pending;
  };

  pi.events.on(JEV_BRIDGE_CHANNEL, createJevBridgeHandler(clientFor));
  pi.on("session_shutdown", async () => {
    const pending = [...clients.values()];
    clients.clear();
    const resolved = await Promise.allSettled(pending);
    await Promise.all(
      resolved.flatMap((result) => (result.status === "fulfilled" ? [result.value.close()] : [])),
    );
  });

  pi.registerTool({
    name: "jev_evaluate",
    label: "Evaluate with Jev",
    description:
      "Evaluate bounded JSON state against mixed Choice, Score, and Noul questions using the pinned TypeSafe Jev model. Returns typed answers, probabilities, usage, reported model, and latency; it does not collect state or apply caller policy.",
    parameters: JevEvaluateParameters,
    executionMode: "parallel",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      let request;
      try {
        request = parseEvaluateRequest(parameters);
      } catch (cause) {
        throw new JevFailure(
          "request_invalid",
          cause instanceof Error ? cause.message : "Invalid Jev request.",
        );
      }
      const deadlineMs = parameters.deadlineMs;
      const client = await clientFor(ctx.cwd);
      const evaluationOptions: JevEvaluationOptions = {};
      if (signal !== undefined) evaluationOptions.signal = signal;
      if (deadlineMs !== undefined) evaluationOptions.deadlineMs = deadlineMs;
      const evaluation = await client.evaluate(request, evaluationOptions);
      return {
        content: [{ type: "text", text: renderEvaluation(evaluation) }],
        details: {
          model: evaluation.model,
          usage: evaluation.usage,
          latencyMs: evaluation.meta.latencyMs,
          attempts: evaluation.meta.attempts,
        },
      };
    },
  });
}

export { createJevBridgeHandler, JevFailure, createJevClient, resolveJevConfig };
export {
  bridgeRequest,
  JEV_BRIDGE_CHANNEL,
  JEV_BRIDGE_VERSION,
  requestJevJudgment,
} from "./bridge.ts";
export * from "./contract.ts";
export type { JevConfig } from "./config.ts";
export type { JevClient } from "./client.ts";
