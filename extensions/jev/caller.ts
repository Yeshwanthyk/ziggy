/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor, ziggy-effect/no-instanceof-error, ziggy/no-unknown-parameters, ziggy/no-unsafe-dictionary-type, ziggy/no-runtime-typeof, ziggy/no-conditional-empty-object-spread, ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion, ziggy/require-readable-spacing -- This standalone file owns the validated Jev event contract and one bounded Promise per caller request. */

import { randomUUID } from "node:crypto";

export const JEV_BRIDGE_CHANNEL = "ziggy:jev:judgment:v1";
export const JEV_BRIDGE_VERSION = 1 as const;
export const DEFAULT_MODEL = "jev-1.13.0";
export const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export const MAX_STATE_BYTES = 256 * 1024;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 48 * 1024;
export const MAX_QUESTIONS = 64;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type StructuredContent = string | JsonObject | JsonValue[] | null;
export type JevState = StructuredContent;

export type ChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: StructuredContent;
  readonly criteria: Readonly<Record<string, StructuredContent | null>>;
};

export type ScoreQuestion = {
  readonly type: "score";
  readonly instructions: StructuredContent;
  readonly criteria: readonly [StructuredContent, StructuredContent, ...StructuredContent[]];
};

export type NoulQuestion = {
  readonly type: "noul";
  readonly instructions: StructuredContent;
  readonly criteria?: {
    readonly true?: StructuredContent;
    readonly false?: StructuredContent;
  } | null;
};

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export type EvaluateRequest = {
  readonly state: JevState;
  readonly model?: string;
  readonly questions: Readonly<Record<string, Question>>;
};

export type ChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type ScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, StructuredContent>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type NoulAnswer = {
  readonly type: "noul";
  readonly noul: number;
};

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type JevUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
};

export type JevEvaluation = {
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: JevUsage;
  readonly meta: {
    readonly latencyMs: number;
    readonly attempts: number;
  };
};

export type JevBridgeError = {
  readonly code: string;
  readonly message: string;
};

export type JevBridgeRequest = {
  readonly version: typeof JEV_BRIDGE_VERSION;
  readonly requestId: string;
  readonly operation: "evaluate";
  readonly profilePath: string;
  readonly request: EvaluateRequest;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly accept: () => void;
  readonly reply: (response: JevBridgeReply) => void;
};

export type JevBridgeReply =
  | {
      readonly version: typeof JEV_BRIDGE_VERSION;
      readonly requestId: string;
      readonly ok: true;
      readonly evaluation: JevEvaluation;
    }
  | {
      readonly version: typeof JEV_BRIDGE_VERSION;
      readonly requestId: string;
      readonly ok: false;
      readonly error: JevBridgeError;
    };

export type JevEventBus = {
  readonly emit: (channel: string, data: unknown) => void;
};

export type JevCallerOptions = {
  readonly profilePath: string;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
};

export type JevFailureCode =
  | "cancelled"
  | "deadline_exceeded"
  | "credentials_missing"
  | "config_invalid"
  | "request_invalid"
  | "response_invalid"
  | "response_too_large"
  | "rate_limited"
  | "upstream_http"
  | "bridge_listener_missing"
  | "bridge_timeout";

export class JevCallerFailure extends Error {
  readonly code: JevFailureCode;

  constructor(code: JevFailureCode, message: string) {
    super(message);
    this.name = "JevCallerFailure";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isJsonValue = (value: unknown, depth = 0): value is JsonValue => {
  if (depth > 20) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 256 && value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length <= 256 &&
    keys.every((key) => key.length > 0 && key.length <= 256 && isJsonValue(value[key], depth + 1))
  );
};

const isStructuredContent = (value: unknown): value is StructuredContent =>
  value === null || typeof value === "string" || (isJsonValue(value) && typeof value === "object");

const isState = (value: unknown): value is JevState => isStructuredContent(value);

const jsonEquals = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEquals(item, right[index] as JsonValue))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonEquals(left[key] as JsonValue, right[key] as JsonValue),
    )
  );
};

const boundedText = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const isQuestion = (value: unknown): value is Question => {
  if (!isRecord(value) || !isStructuredContent(value.instructions)) return false;
  if (value.type === "choice") {
    if (
      !isRecord(value.criteria) ||
      Object.keys(value.criteria).length < 2 ||
      Object.keys(value.criteria).length > 255
    )
      return false;
    return Object.entries(value.criteria).every(
      ([key, criterion]) => boundedText(key, 128) && isStructuredContent(criterion),
    );
  }
  if (value.type === "score") {
    return (
      Array.isArray(value.criteria) &&
      value.criteria.length >= 2 &&
      value.criteria.length <= 10 &&
      value.criteria.every(isStructuredContent)
    );
  }
  if (value.type === "noul") {
    if (value.criteria === undefined || value.criteria === null) return true;
    return (
      isRecord(value.criteria) &&
      (value.criteria.true === undefined || isStructuredContent(value.criteria.true)) &&
      (value.criteria.false === undefined || isStructuredContent(value.criteria.false))
    );
  }
  return false;
};

export const isJsonState = (value: unknown): value is JevState => isState(value);

export const parseEvaluateRequest = (value: unknown): EvaluateRequest => {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "state") ||
    !isState(value.state) ||
    !isRecord(value.questions)
  )
    throw new Error("Invalid Jev request: state and questions are required.");
  if (value.model !== undefined && !boundedText(value.model, 128))
    throw new Error("Invalid Jev request: model must be a non-empty bounded string.");
  const entries = Object.entries(value.questions);
  const questions = Object.create(null) as Record<string, Question>;
  if (entries.length < 1 || entries.length > MAX_QUESTIONS)
    throw new Error(`Invalid Jev request: questions must contain 1-${MAX_QUESTIONS} entries.`);
  for (const [id, question] of entries) {
    if (!boundedText(id, 128) || !isQuestion(question))
      throw new Error(`Invalid Jev request: question '${id}' is malformed.`);
    questions[id] = question;
  }
  const request: EvaluateRequest = {
    state: value.state,
    questions,
    ...(value.model === undefined ? {} : { model: value.model }),
  };
  if (jsonBytes(request.state) > MAX_STATE_BYTES)
    throw new Error("Invalid Jev request: state is too large.");
  if (jsonBytes(request) > MAX_REQUEST_BYTES)
    throw new Error("Invalid Jev request: JSON payload is too large.");
  return request;
};

export const jsonBytes = (value: JsonValue | EvaluateRequest | JevEvaluation): number => {
  const serialized = JSON.stringify(value);
  return new TextEncoder().encode(serialized).byteLength;
};

const isProbabilityMap = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, number> => {
  if (!isRecord(value) || Object.keys(value).length !== keys.length) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join("\u0000") !== expected.join("\u0000")) return false;
  const probabilities = Object.values(value);
  if (
    !probabilities.every(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1,
    )
  )
    return false;
  const total = probabilities.reduce((sum, item) => sum + item, 0);
  return Math.abs(total - 1) <= 1e-6;
};

const isAnswerFor = (question: Question, value: unknown): value is Answer => {
  if (!isRecord(value) || value.type !== question.type) return false;
  if (question.type === "noul")
    return (
      typeof value.noul === "number" &&
      Number.isFinite(value.noul) &&
      value.noul >= 0 &&
      value.noul <= 1
    );
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    if (
      !boundedText(value.choice, 128) ||
      !options.includes(value.choice) ||
      typeof value.confidence !== "number" ||
      value.confidence < 0 ||
      value.confidence > 1 ||
      !isProbabilityMap(value.probabilities, options)
    )
      return false;
    const selectedProbability = value.probabilities[value.choice] ?? -1;
    const maximumProbability = Math.max(...Object.values(value.probabilities));
    return selectedProbability >= maximumProbability - 1e-12;
  }
  const levels = question.criteria.map((_item, index) => String(index));
  if (
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    value.score < 0 ||
    value.score > question.criteria.length - 1
  )
    return false;
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    !isRecord(value.legend)
  )
    return false;
  const legendEntries = Object.entries(value.legend);
  return (
    legendEntries.length === levels.length &&
    legendEntries.every(
      ([key, description], index) =>
        key === String(index) &&
        isStructuredContent(description) &&
        jsonEquals(description, question.criteria[index] as JsonValue),
    ) &&
    isProbabilityMap(value.probabilities, levels) &&
    Math.abs(
      value.score -
        levels.reduce(
          (expected, level, index) =>
            expected + index * ((value.probabilities as Record<string, number>)[level] ?? 0),
          0,
        ),
    ) <=
      0.005 + Number.EPSILON
  );
};

export const parseJevResponse = (
  value: unknown,
  request: EvaluateRequest,
  meta: JevEvaluation["meta"],
): JevEvaluation => {
  if (
    !isRecord(value) ||
    !boundedText(value.model, 128) ||
    !isRecord(value.answers) ||
    !isRecord(value.usage)
  )
    throw new Error("Invalid Jev response envelope.");
  const requestIds = Object.keys(request.questions);
  const responseIds = Object.keys(value.answers);
  if (
    requestIds.length !== responseIds.length ||
    !requestIds.every((id) => Object.prototype.hasOwnProperty.call(value.answers, id))
  )
    throw new Error("Invalid Jev response: answers do not match the requested questions.");
  const inputTokens = value.usage.input_tokens;
  const outputTokens = value.usage.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    inputTokens > 1_000_000_000 ||
    typeof outputTokens !== "number" ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 0 ||
    outputTokens > 1_000_000_000
  )
    throw new Error("Invalid Jev response: usage is malformed.");
  const answers = Object.create(null) as Record<string, Answer>;
  for (const id of requestIds) {
    const answer = value.answers[id];
    const question = request.questions[id];
    if (question === undefined || !isAnswerFor(question, answer))
      throw new Error(`Invalid Jev response: answer '${id}' is malformed.`);
    answers[id] = answer;
  }
  if (
    typeof meta.latencyMs !== "number" ||
    !Number.isFinite(meta.latencyMs) ||
    meta.latencyMs < 0 ||
    meta.latencyMs > 1_000_000 ||
    typeof meta.attempts !== "number" ||
    !Number.isInteger(meta.attempts) ||
    meta.attempts < 1 ||
    meta.attempts > 4
  )
    throw new Error("Invalid Jev response: metadata is malformed.");
  const evaluation: JevEvaluation = {
    model: value.model,
    answers,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    meta,
  };
  if (jsonBytes(evaluation) > MAX_RESPONSE_BYTES)
    throw new Error("Invalid Jev response: JSON payload is too large.");
  return evaluation;
};

export const isBridgeRequest = (value: unknown): value is JevBridgeRequest => {
  if (!isRecord(value) || value.version !== JEV_BRIDGE_VERSION || value.operation !== "evaluate")
    return false;
  return (
    boundedText(value.requestId, 128) &&
    boundedText(value.profilePath, 4096) &&
    (value.deadlineMs === undefined ||
      (typeof value.deadlineMs === "number" &&
        Number.isInteger(value.deadlineMs) &&
        value.deadlineMs >= 100 &&
        value.deadlineMs <= 120_000)) &&
    typeof value.accept === "function" &&
    typeof value.reply === "function"
  );
};

const failureCodes: ReadonlySet<string> = new Set<JevFailureCode>([
  "cancelled",
  "deadline_exceeded",
  "credentials_missing",
  "config_invalid",
  "request_invalid",
  "response_invalid",
  "response_too_large",
  "rate_limited",
  "upstream_http",
  "bridge_listener_missing",
  "bridge_timeout",
]);

const callerMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Invalid Jev request.";

export const requestJevJudgment = (
  events: JevEventBus,
  requestInput: EvaluateRequest,
  options: JevCallerOptions,
): Promise<JevEvaluation> => {
  let request: EvaluateRequest;
  try {
    request = parseEvaluateRequest(requestInput);
  } catch (cause) {
    return Promise.reject(new JevCallerFailure("request_invalid", callerMessage(cause)));
  }
  const deadlineMs = options.deadlineMs ?? 30_000;
  if (!options.profilePath.trim() || options.profilePath.length > 4096)
    return Promise.reject(new JevCallerFailure("request_invalid", "Jev profile path is invalid."));
  if (!Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 120_000)
    return Promise.reject(
      new JevCallerFailure("request_invalid", "Jev deadlineMs must be 100-120000."),
    );

  const requestId = randomUUID();
  const controller = new AbortController();
  let accepted = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Promise<JevEvaluation>((resolve, reject) => {
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    };
    const fail = (failure: JevCallerFailure) => {
      if (settled) return;
      settled = true;
      controller.abort();
      cleanup();
      reject(failure);
    };
    const onCallerAbort = () =>
      fail(new JevCallerFailure("cancelled", "Jev bridge request was cancelled."));
    const onDeadline = () =>
      fail(new JevCallerFailure("bridge_timeout", "Jev bridge request timed out."));

    timer = setTimeout(onDeadline, deadlineMs);
    if (options.signal?.aborted) {
      onCallerAbort();
      return;
    }
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const reply = (response: unknown): void => {
      if (settled) return;
      if (
        !isRecord(response) ||
        response.version !== JEV_BRIDGE_VERSION ||
        response.requestId !== requestId ||
        typeof response.ok !== "boolean"
      ) {
        fail(new JevCallerFailure("response_invalid", "Jev bridge returned an invalid reply."));
        return;
      }
      if (response.ok === false) {
        const error = response.error;
        if (
          !isRecord(error) ||
          !boundedText(error.code, 64) ||
          !failureCodes.has(error.code) ||
          !boundedText(error.message, 1_024) ||
          Object.keys(error).some((key) => key !== "code" && key !== "message") ||
          Object.keys(response).some(
            (key) => key !== "version" && key !== "requestId" && key !== "ok" && key !== "error",
          )
        ) {
          fail(new JevCallerFailure("response_invalid", "Jev bridge returned an invalid reply."));
          return;
        }
        fail(new JevCallerFailure(error.code as JevFailureCode, error.message));
        return;
      }
      if (
        Object.keys(response).some(
          (key) => key !== "version" && key !== "requestId" && key !== "ok" && key !== "evaluation",
        )
      ) {
        fail(new JevCallerFailure("response_invalid", "Jev bridge returned an invalid reply."));
        return;
      }
      let evaluation: JevEvaluation;
      try {
        const rawEvaluation = response.evaluation;
        if (!isRecord(rawEvaluation) || !isRecord(rawEvaluation.meta))
          throw new Error("Invalid bridge evaluation.");
        evaluation = parseJevResponse(rawEvaluation, request, {
          latencyMs: rawEvaluation.meta.latencyMs as number,
          attempts: rawEvaluation.meta.attempts as number,
        });
      } catch {
        fail(
          new JevCallerFailure("response_invalid", "Jev bridge returned an invalid evaluation."),
        );
        return;
      }
      settled = true;
      cleanup();
      resolve(evaluation);
    };

    try {
      events.emit(JEV_BRIDGE_CHANNEL, {
        version: JEV_BRIDGE_VERSION,
        requestId,
        operation: "evaluate",
        profilePath: options.profilePath,
        request,
        signal: controller.signal,
        deadlineMs,
        accept: () => {
          accepted = true;
        },
        reply,
      } satisfies JevBridgeRequest);
    } catch {
      fail(
        new JevCallerFailure(
          "upstream_http",
          "Jev bridge listener failed while accepting the request.",
        ),
      );
      return;
    }
    if (!accepted)
      fail(new JevCallerFailure("bridge_listener_missing", "No Jev bridge listener is installed."));
  });
};

export const bridgeRequest = requestJevJudgment;
