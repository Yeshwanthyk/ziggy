/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor, ziggy-effect/no-json-parse, ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion, ziggy/require-readable-spacing -- Tests exercise the explicit HTTP and event boundary fixtures. */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevClient } from "../client.ts";
import { createJevBridgeHandler, requestJevJudgment } from "../bridge.ts";
import { JevCallerFailure } from "../caller.ts";
import { resolveJevConfig } from "../config.ts";
import { JevEvaluateParameters } from "../index.ts";
import {
  parseEvaluateRequest,
  parseJevResponse,
  type ChoiceQuestion,
  type EvaluateRequest,
} from "../contract.ts";

type MalformedBridgeReply = {
  readonly version: number;
  readonly requestId: string;
  readonly ok: false;
  readonly error: null | { readonly code: string; readonly message: string };
};

const teamQuestion = {
  type: "choice",
  instructions: { question: "Which team owns this?", focus: "Primary issue" },
  criteria: { frontend: { what: "Browser UI defects" }, billing: null },
} satisfies ChoiceQuestion;

const request: EvaluateRequest = {
  state: { message: "The export button crashes in Safari." },
  questions: {
    team: teamQuestion,
    severity: {
      type: "score",
      instructions: "How severe is the issue?",
      criteria: ["Cosmetic", { what: "Broken but has a workaround" }, "Blocking"],
    },
    review: {
      type: "noul",
      instructions: "Does this require human review?",
      criteria: { true: "Evidence is ambiguous", false: "Evidence is clear" },
    },
  },
};

const response = () =>
  new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        team: {
          type: "choice",
          choice: "frontend",
          probabilities: { frontend: 0.9, billing: 0.1 },
          confidence: 0.8,
        },
        severity: {
          type: "score",
          score: 1.2,
          legend: {
            "0": "Cosmetic",
            "1": { what: "Broken but has a workaround" },
            "2": "Blocking",
          },
          probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
          confidence: 0.5,
        },
        review: { type: "noul", noul: 0.2 },
      },
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const config = {
  apiKey: "test-key",
  model: "jev-1.13.0",
  baseUrl: "https://api.typesafe.ai/v1/systemone",
  timeoutMs: 10_000,
  maxRetries: 2,
};

test("accepts complete mixed Choice, Score, and Noul requests with structured content", () => {
  expect(parseEvaluateRequest(request)).toEqual(request);
});

test("rejects malformed upstream answers before exposing them", async () => {
  const client = new JevClient(config, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            team: {
              type: "choice",
              choice: "not-an-option",
              probabilities: { frontend: 1, billing: 0 },
              confidence: 1,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
  });
  await expect(
    client.evaluate({ state: "x", questions: { team: teamQuestion } }),
  ).rejects.toMatchObject({ code: "response_invalid" });
});

test("reports a missing bridge listener explicitly", async () => {
  const pending = requestJevJudgment({ emit: () => undefined }, request, {
    profilePath: "/tmp/profile",
    deadlineMs: 100,
  });
  await expect(pending).rejects.toBeInstanceOf(JevCallerFailure);
  await expect(pending).rejects.toMatchObject({ code: "bridge_listener_missing" });
});

test("cancels an in-flight HTTP request", async () => {
  const caller = new AbortController();
  const client = new JevClient(config, {
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const pending = client.evaluate(request, { signal: caller.signal, deadlineMs: 1_000 });
  caller.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
});

test("retries documented rate limits, honoring Retry-After, and reports attempts and latency", async () => {
  let calls = 0;
  const waits: number[] = [];
  const client = new JevClient(config, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429, headers: { "retry-after": "0" } })
        : response();
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    now: (() => {
      let value = 1_000;
      return () => (value += 7);
    })(),
  });
  const result = await client.evaluate(request);
  expect(calls).toBe(2);
  expect(waits).toEqual([0]);
  expect(result).toMatchObject({
    model: "jev-1.13.0",
    usage: { input_tokens: 10, output_tokens: 20 },
    meta: { attempts: 2 },
  });
});

test("bridge round-trips a validated judgment", async () => {
  const client = new JevClient(config, { fetchImpl: async () => response() });
  const handle = createJevBridgeHandler(async () => client);
  const pending = requestJevJudgment(
    {
      emit: (_channel, data) => {
        handle(data);
      },
    },
    request,
    { profilePath: "/tmp/profile", deadlineMs: 1_000 },
  );
  await expect(pending).resolves.toMatchObject({
    model: "jev-1.13.0",
    answers: { team: { choice: "frontend" } },
  });
});

test("advertises typed Choice, Score, and Noul tool questions", () => {
  const schema = JSON.stringify(JevEvaluateParameters);
  expect(schema).toContain('"choice"');
  expect(schema).toContain('"score"');
  expect(schema).toContain('"noul"');
  expect(schema).toContain('"instructions"');
  expect(schema).toContain('"criteria"');
  expect(schema).toContain('"minItems":2');
});

test("sends the official envelope with a pinned or per-request model", async () => {
  let captured:
    | {
        url: string;
        authorization: string | null;
        body: unknown;
        redirect: RequestInit["redirect"];
      }
    | undefined;
  const client = new JevClient(config, {
    fetchImpl: async (input, init) => {
      captured = {
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as unknown,
        redirect: init?.redirect,
      };
      return response();
    },
  });
  await client.evaluate({ ...request, model: "jev-1.13.0" });
  expect(captured).toEqual({
    url: "https://api.typesafe.ai/v1/systemone",
    authorization: "Bearer test-key",
    body: { state: request.state, model: "jev-1.13.0", questions: request.questions },
    redirect: "error",
  });
});

test("rejects unsupported primitive state and accepts documented null structure", () => {
  expect(() => parseEvaluateRequest({ ...request, state: 42 })).toThrow();
  expect(
    parseEvaluateRequest({
      state: null,
      questions: {
        "1 nullable question": {
          type: "score",
          instructions: null,
          criteria: [null, { examples: ["present"] }],
        },
      },
    }),
  ).toEqual({
    state: null,
    questions: {
      "1 nullable question": {
        type: "score",
        instructions: null,
        criteria: [null, { examples: ["present"] }],
      },
    },
  });
});

test("validates Choice and Score probability semantics without rejecting rounded scores", () => {
  const choiceRequest = parseEvaluateRequest({
    state: "x",
    questions: {
      route: {
        type: "choice",
        instructions: "Route this",
        criteria: { a: null, b: null },
      },
    },
  });
  const choiceEnvelope = (choice: string, probabilities: Record<string, number>) => ({
    model: "jev-1.13.0",
    answers: { route: { type: "choice", choice, probabilities, confidence: 0.5 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  expect(() =>
    parseJevResponse(choiceEnvelope("a", { a: 0.4, b: 0.6 }), choiceRequest, {
      latencyMs: 1,
      attempts: 1,
    }),
  ).toThrow();
  expect(() =>
    parseJevResponse(choiceEnvelope("a", { a: 0.5, b: 0.5 }), choiceRequest, {
      latencyMs: 1,
      attempts: 1,
    }),
  ).not.toThrow();
  expect(() =>
    parseJevResponse(choiceEnvelope("a", { a: 0.5, b: 0.49 }), choiceRequest, {
      latencyMs: 1,
      attempts: 1,
    }),
  ).toThrow();

  const scoreRequest = parseEvaluateRequest({
    state: "x",
    questions: {
      score: {
        type: "score",
        instructions: "Score this",
        criteria: ["low", "high"],
      },
    },
  });
  const scoreEnvelope = (score: number) => ({
    model: "jev-1.13.0",
    answers: {
      score: {
        type: "score",
        score,
        legend: { "0": "low", "1": "high" },
        probabilities: { "0": 0.5, "1": 0.5 },
        confidence: 0.5,
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  expect(() =>
    parseJevResponse(scoreEnvelope(0.8), scoreRequest, { latencyMs: 1, attempts: 1 }),
  ).toThrow();
  expect(() =>
    parseJevResponse(scoreEnvelope(0.504), scoreRequest, { latencyMs: 1, attempts: 1 }),
  ).not.toThrow();
});

test("compares structured Score legends independent of object key order", () => {
  const structuredRequest = parseEvaluateRequest({
    state: "x",
    questions: {
      score: {
        type: "score",
        instructions: "Score this",
        criteria: [
          { label: "low", examples: ["a"] },
          { label: "high", examples: ["b"] },
        ],
      },
    },
  });
  expect(() =>
    parseJevResponse(
      {
        model: "jev-1.13.0",
        answers: {
          score: {
            type: "score",
            score: 0.75,
            legend: {
              "0": { examples: ["a"], label: "low" },
              "1": { examples: ["b"], label: "high" },
            },
            probabilities: { "0": 0.25, "1": 0.75 },
            confidence: 0.5,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      structuredRequest,
      { latencyMs: 1, attempts: 1 },
    ),
  ).not.toThrow();
});

test("preserves __proto__ question and answer ids in null-prototype maps", () => {
  const protoRequest = parseEvaluateRequest(
    JSON.parse(
      '{"state":"x","questions":{"__proto__":{"type":"noul","instructions":"Is this true?"}}}',
    ) as unknown,
  );
  expect(Object.getPrototypeOf(protoRequest.questions)).toBeNull();
  expect(Object.hasOwn(protoRequest.questions, "__proto__")).toBe(true);

  const evaluation = parseJevResponse(
    JSON.parse(
      '{"model":"jev-1.13.0","answers":{"__proto__":{"type":"noul","noul":0.5}},"usage":{"input_tokens":1,"output_tokens":1}}',
    ) as unknown,
    protoRequest,
    { latencyMs: 1, attempts: 1 },
  );
  expect(Object.getPrototypeOf(evaluation.answers)).toBeNull();
  expect(Object.hasOwn(evaluation.answers, "__proto__")).toBe(true);
});

test("rejects malformed bridge failure replies immediately", async () => {
  const pending = requestJevJudgment(
    {
      emit: (_channel, data) => {
        const event = data as {
          accept: () => void;
          reply: (response: MalformedBridgeReply) => void;
          requestId: string;
        };
        event.accept();
        queueMicrotask(() =>
          event.reply({ version: 1, requestId: event.requestId, ok: false, error: null }),
        );
      },
    },
    request,
    { profilePath: "/tmp/profile", deadlineMs: 1_000 },
  );
  await expect(pending).rejects.toMatchObject({ code: "response_invalid" });

  const oversized = requestJevJudgment(
    {
      emit: (_channel, data) => {
        const event = data as {
          accept: () => void;
          reply: (response: MalformedBridgeReply) => void;
          requestId: string;
        };
        event.accept();
        event.reply({
          version: 1,
          requestId: event.requestId,
          ok: false,
          error: { code: "upstream_http", message: "x".repeat(1_025) },
        });
      },
    },
    request,
    { profilePath: "/tmp/profile", deadlineMs: 1_000 },
  );
  await expect(oversized).rejects.toMatchObject({ code: "response_invalid" });
});

test("enforces an end-to-end request deadline", async () => {
  const client = new JevClient(config, {
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  await expect(client.evaluate(request, { deadlineMs: 100 })).rejects.toMatchObject({
    code: "deadline_exceeded",
  });
});

test("bounds retries for transient connection and server failures", async () => {
  let connectionCalls = 0;
  const connectionClient = new JevClient(config, {
    fetchImpl: async () => {
      connectionCalls += 1;
      throw new Error("offline");
    },
    sleep: async () => undefined,
  });
  await expect(connectionClient.evaluate(request)).rejects.toMatchObject({ code: "upstream_http" });
  expect(connectionCalls).toBe(3);

  let serverCalls = 0;
  const serverClient = new JevClient(config, {
    fetchImpl: async () => {
      serverCalls += 1;
      return serverCalls === 1 ? new Response("busy", { status: 503 }) : response();
    },
    sleep: async () => undefined,
  });
  await expect(serverClient.evaluate(request)).resolves.toMatchObject({ meta: { attempts: 2 } });
});

test("close cancels active work and rejects future requests", async () => {
  const client = new JevClient(config, {
    fetchImpl: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const active = client.evaluate(request);
  await client.close();
  await expect(active).rejects.toMatchObject({ code: "cancelled" });
  await expect(client.evaluate(request)).rejects.toMatchObject({ code: "config_invalid" });
});

test("restricts credential-bearing requests to TypeSafe or localhost", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "jev-base-url-"));
  const configDirectory = join(profilePath, ".pi");
  const configPath = join(configDirectory, "jev.json");
  try {
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configPath, JSON.stringify({ baseUrl: "https://api.typesafe.ai.evil.test/" }), {
      mode: 0o600,
    });
    await expect(resolveJevConfig(profilePath, { TYPESAFE_API_KEY: "env-key" })).rejects.toThrow(
      "TypeSafe System One endpoint",
    );

    await writeFile(configPath, JSON.stringify({ baseUrl: "http://127.0.0.1:8787/systemone" }), {
      mode: 0o600,
    });
    await expect(resolveJevConfig(profilePath, { TYPESAFE_API_KEY: "env-key" })).resolves.toEqual({
      apiKey: "env-key",
      model: "jev-1.13.0",
      baseUrl: "http://127.0.0.1:8787/systemone",
      timeoutMs: 30_000,
      maxRetries: 2,
    });
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("resolves TYPESAFE_API_KEY without reading a credential file", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "jev-config-"));
  try {
    await expect(resolveJevConfig(profilePath, { TYPESAFE_API_KEY: " env-key " })).resolves.toEqual(
      {
        apiKey: "env-key",
        model: "jev-1.13.0",
        baseUrl: "https://api.typesafe.ai/v1/systemone",
        timeoutMs: 30_000,
        maxRetries: 2,
      },
    );
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});
