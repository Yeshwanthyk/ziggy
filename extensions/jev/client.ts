/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-instanceof-error, ziggy-effect/no-json-parse, ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion, ziggy/require-readable-spacing -- Fetch, timers, and JSON are confined to this external service adapter. */

import {
  MAX_RESPONSE_BYTES,
  parseEvaluateRequest,
  parseJevResponse,
  type EvaluateRequest,
  type JevFailureCode,
  type JevEvaluation,
} from "./contract.ts";
import type { JevConfig } from "./config.ts";

export class JevFailure extends Error {
  readonly code: JevFailureCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: JevFailureCode,
    message: string,
    details?: { status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "JevFailure";
    this.code = code;
    if (details?.status !== undefined) this.status = details.status;
    if (details?.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type ClientOptions = {
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
};

const MAX_MODEL_BYTES = 128;
const parseRetryAfter = (
  header: string | null,
  millisecondHeader: string | null,
  now: number,
): number | undefined => {
  if (millisecondHeader) {
    const milliseconds = Number(millisecondHeader);
    if (Number.isFinite(milliseconds) && milliseconds >= 0)
      return Math.min(30_000, Math.round(milliseconds));
  }
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1000));
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(30_000, Math.max(0, date - now));
};

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status === 529 || (status >= 500 && status <= 599);

const discardBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new JevFailure("cancelled", "Jev evaluation was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JevFailure("cancelled", "Jev evaluation was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

const readBoundedText = async (response: Response): Promise<string> => {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
      throw new JevFailure("response_too_large", "Jev response exceeded the size limit.");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new JevFailure("response_too_large", "Jev response exceeded the size limit.");
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
};

const remainingMs = (deadline: number, now: () => number): number => Math.max(0, deadline - now());

export type JevEvaluationOptions = {
  signal?: AbortSignal;
  deadlineMs?: number;
};

export class JevClient {
  private readonly active = new Set<AbortController>();
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private closed = false;

  constructor(
    private readonly config: JevConfig,
    options: ClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
  }

  async evaluate(
    input: EvaluateRequest,
    options: JevEvaluationOptions = {},
  ): Promise<JevEvaluation> {
    if (this.closed) throw new JevFailure("config_invalid", "Jev client is closed.");
    let request: EvaluateRequest;
    try {
      request = parseEvaluateRequest(input);
    } catch (cause) {
      throw new JevFailure(
        "request_invalid",
        cause instanceof Error ? cause.message : "Invalid Jev request.",
      );
    }
    const deadlineMs = options.deadlineMs ?? this.config.timeoutMs;
    if (!Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 120_000)
      throw new JevFailure("request_invalid", "Jev deadlineMs must be 100-120000.");
    if (Buffer.byteLength(this.config.model) > MAX_MODEL_BYTES)
      throw new JevFailure("config_invalid", "Jev model configuration is invalid.");
    const startedAt = this.now();
    const deadline = startedAt + deadlineMs;
    const controller = new AbortController();
    this.active.add(controller);
    const onCallerAbort = () => controller.abort();
    const timeout = setTimeout(() => controller.abort(), deadlineMs);
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const abortedFailure = (): JevFailure =>
      new JevFailure(
        options.signal?.aborted || this.closed ? "cancelled" : "deadline_exceeded",
        options.signal?.aborted || this.closed
          ? "Jev evaluation was cancelled."
          : "Jev evaluation deadline exceeded.",
      );
    let attempts = 0;
    try {
      const body = JSON.stringify({
        state: request.state,
        model: request.model ?? this.config.model,
        questions: request.questions,
      });
      for (;;) {
        if (controller.signal.aborted) throw abortedFailure();
        attempts += 1;
        let response: Response;
        try {
          response = await this.fetchImpl(this.config.baseUrl, {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              "Content-Type": "application/json",
            },
            body,
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted) throw abortedFailure();
          if (attempts <= this.config.maxRetries) {
            const backoff = Math.min(5_000, 250 * 2 ** (attempts - 1));
            if (remainingMs(deadline, this.now) <= backoff)
              throw new JevFailure("deadline_exceeded", "Jev retry deadline exceeded.");
            try {
              await this.sleepImpl(backoff, controller.signal);
            } catch (cause) {
              if (controller.signal.aborted) throw abortedFailure();
              throw cause;
            }
            continue;
          }
          throw new JevFailure("upstream_http", "Jev request could not reach the service.");
        }
        if (response.ok) {
          let payload: unknown;
          try {
            payload = JSON.parse(await readBoundedText(response)) as unknown;
          } catch (cause) {
            if (controller.signal.aborted) throw abortedFailure();
            if (cause instanceof JevFailure) throw cause;
            throw new JevFailure("response_invalid", "Jev returned invalid JSON.");
          }
          try {
            return parseJevResponse(payload, request, {
              latencyMs: Math.max(0, this.now() - startedAt),
              attempts,
            });
          } catch (cause) {
            throw new JevFailure(
              "response_invalid",
              cause instanceof Error ? cause.message : "Jev returned an invalid response.",
            );
          }
        }
        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
          response.headers.get("retry-after-ms"),
          this.now(),
        );
        if (isRetryableStatus(response.status) && attempts <= this.config.maxRetries) {
          await discardBody(response);
          const backoff = retryAfterMs ?? Math.min(5_000, 250 * 2 ** (attempts - 1));
          if (remainingMs(deadline, this.now) <= backoff)
            throw new JevFailure("deadline_exceeded", "Jev retry deadline exceeded.");
          try {
            await this.sleepImpl(backoff, controller.signal);
          } catch (cause) {
            if (controller.signal.aborted) throw abortedFailure();
            throw cause;
          }
          continue;
        }
        await discardBody(response);
        if (response.status === 429 || response.status === 529)
          throw new JevFailure(
            "rate_limited",
            "Jev service remained rate limited after bounded retries.",
            retryAfterMs === undefined
              ? { status: response.status }
              : { status: response.status, retryAfterMs },
          );
        throw new JevFailure("upstream_http", `Jev service returned HTTP ${response.status}.`, {
          status: response.status,
        });
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onCallerAbort);
      this.active.delete(controller);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}

export const createJevClient = (config: JevConfig, options?: ClientOptions): JevClient =>
  new JevClient(config, options);
