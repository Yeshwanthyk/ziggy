import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import {
  decodeClientRequest,
  encodeServerFrame,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "../../packages/protocol/src/index.ts";
import {
  AuthClientError,
  loginProvider,
  queryProviderAuthStatus,
  type AuthClientTransport,
} from "../../packages/ziggy/src/auth-client.ts";
import { forkEffect, runEffect } from "../testkit/effect.ts";

class FakeAuthTransport implements AuthClientTransport {
  readonly writes: string[] = [];
  destroyCalls = 0;
  private readonly writeWaiters: Array<{
    readonly count: number;
    readonly resolve: () => void;
  }> = [];
  private dataListener: ((chunk: Buffer | string) => void) | undefined;
  private connectListener: (() => void) | undefined;
  private closeListener: (() => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;
  private writeFailure: "throw" | "callback" | "pending" | undefined;

  onData(listener: (chunk: Buffer | string) => void): void {
    this.dataListener = listener;
  }
  onConnect(listener: () => void): void {
    this.connectListener = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }
  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }
  write(data: string, callback: (error?: Error) => void): void {
    if (this.writeFailure === "throw") throw new Error("fixture write detail");
    this.writes.push(data);
    for (let index = this.writeWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.writeWaiters[index];
      if (waiter !== undefined && this.writes.length >= waiter.count) {
        this.writeWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
    if (this.writeFailure !== "pending") {
      callback(this.writeFailure === "callback" ? new Error("fixture callback detail") : undefined);
    }
  }
  destroy(): void {
    this.destroyCalls += 1;
  }
  failNextWrite(mode: "throw" | "callback" | "pending"): void {
    this.writeFailure = mode;
  }
  connect(): void {
    this.connectListener?.();
  }
  close(): void {
    this.closeListener?.();
  }
  error(): void {
    this.errorListener?.(new Error("fixture transport detail"));
  }
  data(chunk: Buffer | string): void {
    this.dataListener?.(chunk);
  }
  waitForWrites(count: number): Promise<void> {
    if (this.writes.length >= count) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    this.writeWaiters.push({ count, resolve: waiter.resolve });
    return waiter.promise;
  }
}

const factory = (transport: FakeAuthTransport) => () => transport;

function initializeFrame(requestId: string): ServerFrame {
  return {
    schemaVersion: PROTOCOL_VERSION,
    requestId,
    method: "initialize",
    type: "success",
    result: { protocolVersion: PROTOCOL_VERSION, features: ["providerAuth"] },
  };
}

function loginSuccess(): ServerFrame {
  return {
    schemaVersion: PROTOCOL_VERSION,
    requestId: "auth-login",
    method: "auth/login",
    type: "success",
    result: {
      status: {
        providerId: "anthropic",
        configured: true,
        type: "api_key",
        source: "stored",
      },
    },
  };
}

function waitForWrites(transport: FakeAuthTransport, count: number): Promise<void> {
  return transport.waitForWrites(count);
}

async function expectPromptRejection(promise: Promise<unknown>, message: string): Promise<void> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error("operation did not settle")), 100);
  try {
    await expect(Promise.race([promise, timeout.promise])).rejects.toThrow(message);
  } finally {
    clearTimeout(timer);
  }
}

test("auth status rejects close before connect and close while waiting for a frame", async () => {
  const opening = new FakeAuthTransport();
  const openingQuery = runEffect(queryProviderAuthStatus("fixture", undefined, factory(opening)));
  opening.close();
  await expectPromptRejection(openingQuery, "transport closed");

  const connected = new FakeAuthTransport();
  const connectedQuery = runEffect(
    queryProviderAuthStatus("fixture", undefined, factory(connected)),
  );
  connected.connect();
  await waitForWrites(connected, 1);
  connected.data(encodeServerFrame(initializeFrame("doctor-initialize")));
  await waitForWrites(connected, 2);
  connected.close();
  await expectPromptRejection(connectedQuery, "transport closed");
});

test("auth status accepts split frames and turns malformed frames into terminal rejection", async () => {
  const split = new FakeAuthTransport();
  const query = runEffect(queryProviderAuthStatus("fixture", undefined, factory(split)));
  split.connect();
  await waitForWrites(split, 1);
  const initialized = encodeServerFrame(initializeFrame("doctor-initialize"));
  split.data(initialized.slice(0, 7));
  split.data(initialized.slice(7));
  await waitForWrites(split, 2);
  const status = encodeServerFrame({
    schemaVersion: PROTOCOL_VERSION,
    requestId: "doctor-auth-status",
    method: "auth/status",
    type: "success",
    result: { providers: [] },
  });
  split.data(status.slice(0, 3));
  split.data(status.slice(3));
  await expect(query).resolves.toEqual([]);

  const malformed = new FakeAuthTransport();
  const malformedQuery = runEffect(
    queryProviderAuthStatus("fixture", undefined, factory(malformed)),
  );
  malformed.connect();
  await waitForWrites(malformed, 1);
  malformed.data('{"schemaVersion":1,"type":"unknown"}\n');
  await expectPromptRejection(malformedQuery, "Malformed attach server frame");
  malformed.close();
});

test("auth status bounds hostile inbound frames per frame and stops delivery after rejection", async () => {
  const hostileFrames = [
    Buffer.alloc(1_048_577, 0x20),
    Buffer.concat([Buffer.alloc(1_048_576, 0x20), Buffer.from("\n")]),
  ];
  for (const hostileFrame of hostileFrames) {
    const transport = new FakeAuthTransport();
    const query = runEffect(queryProviderAuthStatus("fixture", undefined, factory(transport)));
    transport.connect();
    await waitForWrites(transport, 1);
    transport.data(hostileFrame);
    transport.data(encodeServerFrame(initializeFrame("doctor-initialize")));
    await expectPromptRejection(query, "too large");
    expect(transport.destroyCalls).toBe(1);
    expect(transport.writes).toHaveLength(1);
  }

  const split = new FakeAuthTransport();
  const splitQuery = runEffect(queryProviderAuthStatus("fixture", undefined, factory(split)));
  split.connect();
  await waitForWrites(split, 1);
  split.data(Buffer.alloc(1_048_576, 0x20));
  split.data("\n");
  await expectPromptRejection(splitQuery, "too large");
  expect(split.destroyCalls).toBe(1);

  const multiple = new FakeAuthTransport();
  const multipleQuery = runEffect(queryProviderAuthStatus("fixture", undefined, factory(multiple)));
  multiple.connect();
  await waitForWrites(multiple, 1);
  multiple.data(
    Buffer.from(
      `${encodeServerFrame(initializeFrame("doctor-initialize"))}${encodeServerFrame({
        schemaVersion: PROTOCOL_VERSION,
        requestId: "doctor-auth-status",
        method: "auth/status",
        type: "success",
        result: { providers: [] },
      })}`,
    ),
  );
  await expect(multipleQuery).resolves.toEqual([]);

  const flooded = new FakeAuthTransport();
  const floodedQuery = runEffect(queryProviderAuthStatus("fixture", undefined, factory(flooded)));
  flooded.connect();
  await waitForWrites(flooded, 1);
  flooded.data(
    Array.from({ length: 66 }, () => encodeServerFrame(initializeFrame("doctor-initialize"))).join(
      "",
    ),
  );
  await expectPromptRejection(floodedQuery, "queued frames exceeded");
  expect(flooded.destroyCalls).toBe(1);
  expect(flooded.writes).toHaveLength(1);

  const byteFlooded = new FakeAuthTransport();
  const byteFloodedQuery = runEffect(
    queryProviderAuthStatus("fixture", undefined, factory(byteFlooded)),
  );
  byteFlooded.connect();
  await waitForWrites(byteFlooded, 1);
  const largeFrame = encodeServerFrame({
    schemaVersion: PROTOCOL_VERSION,
    type: "auth",
    requestId: "auth-login",
    loginId: "login-1",
    event: { kind: "info", message: "x".repeat(8_000) },
  });
  byteFlooded.data(
    `${encodeServerFrame(initializeFrame("doctor-initialize"))}${largeFrame.repeat(40)}`,
  );
  await expectPromptRejection(byteFloodedQuery, "queued frames exceeded");
  expect(byteFlooded.destroyCalls).toBe(1);
});

test("auth status terminates on socket errors and synchronous or callback write failures", async () => {
  const errored = new FakeAuthTransport();
  const erroredQuery = runEffect(queryProviderAuthStatus("fixture", undefined, factory(errored)));
  errored.connect();
  await waitForWrites(errored, 1);
  errored.error();
  errored.close();
  await expectPromptRejection(erroredQuery, "transport failed");

  const failureModes: ReadonlyArray<"throw" | "callback"> = ["throw", "callback"];
  for (const mode of failureModes) {
    const failed = new FakeAuthTransport();
    failed.failNextWrite(mode);
    const failedQuery = runEffect(queryProviderAuthStatus("fixture", undefined, factory(failed)));
    failed.connect();
    await expectPromptRejection(failedQuery, "write failed");
  }

  const pending = new FakeAuthTransport();
  pending.failNextWrite("pending");
  const pendingQuery = runEffect(queryProviderAuthStatus("fixture", undefined, factory(pending)));
  pending.connect();
  await waitForWrites(pending, 1);
  pending.close();
  await expectPromptRejection(pendingQuery, "transport closed");
});

test("login aborts an active prompt on transport failure without sending a response", async () => {
  const transport = new FakeAuthTransport();
  const promptStarted = Promise.withResolvers<void>();
  let promptAborted = false;
  const login = runEffect(
    loginProvider(
      "fixture",
      "anthropic",
      "api_key",
      {
        notify: () => Effect.void,
        prompt(_event, signal) {
          promptStarted.resolve();
          return Effect.callback<never, AuthClientError>((resume) => {
            signal.addEventListener(
              "abort",
              () => {
                promptAborted = true;
                resume(
                  Effect.fail(
                    new AuthClientError({
                      operation: "fixture-prompt",
                      message: "fixture cancelled",
                    }),
                  ),
                );
              },
              { once: true },
            );
          });
        },
      },
      factory(transport),
    ),
  );
  transport.connect();
  await waitForWrites(transport, 1);
  transport.data(encodeServerFrame(initializeFrame("auth-initialize")));
  await waitForWrites(transport, 2);
  transport.data(
    encodeServerFrame({
      schemaVersion: PROTOCOL_VERSION,
      type: "auth",
      requestId: "auth-login",
      loginId: "login-1",
      event: { kind: "secret", promptId: "prompt-1", message: "Enter key" },
    }),
  );
  await promptStarted.promise;
  transport.close();
  await expectPromptRejection(login, "transport closed");
  expect(promptAborted).toBeTrue();
  expect(
    transport.writes.map((write) => decodeClientRequest(write).method).includes("auth/respond"),
  ).toBeFalse();
});

test("interrupting the login Effect aborts its prompt and destroys the transport", async () => {
  const transport = new FakeAuthTransport();
  const promptStarted = Promise.withResolvers<void>();
  let promptAborted = false;
  const fiber = forkEffect(
    loginProvider(
      "fixture",
      "anthropic",
      "api_key",
      {
        notify: () => Effect.void,
        prompt(_event, signal) {
          promptStarted.resolve();
          return Effect.callback<never, AuthClientError>((resume) => {
            signal.addEventListener(
              "abort",
              () => {
                promptAborted = true;
                resume(
                  Effect.fail(
                    new AuthClientError({
                      operation: "fixture-prompt",
                      message: "fixture cancelled",
                    }),
                  ),
                );
              },
              { once: true },
            );
          });
        },
      },
      factory(transport),
    ),
  );
  transport.connect();
  await waitForWrites(transport, 1);
  transport.data(encodeServerFrame(initializeFrame("auth-initialize")));
  await waitForWrites(transport, 2);
  transport.data(
    encodeServerFrame({
      schemaVersion: PROTOCOL_VERSION,
      type: "auth",
      requestId: "auth-login",
      loginId: "login-1",
      event: { kind: "secret", promptId: "prompt-1", message: "Enter key" },
    }),
  );
  await promptStarted.promise;
  await runEffect(Fiber.interrupt(fiber));
  expect(promptAborted).toBeTrue();
  expect(transport.destroyCalls).toBe(1);
});

test("login rejects errors correlated to an auth prompt response", async () => {
  const transport = new FakeAuthTransport();
  const login = runEffect(
    loginProvider(
      "fixture",
      "anthropic",
      "api_key",
      { notify: () => Effect.void, prompt: () => Effect.succeed("fixture-value") },
      factory(transport),
    ),
  );
  transport.connect();
  await waitForWrites(transport, 1);
  transport.data(encodeServerFrame(initializeFrame("auth-initialize")));
  await waitForWrites(transport, 2);
  transport.data(
    encodeServerFrame({
      schemaVersion: PROTOCOL_VERSION,
      type: "auth",
      requestId: "auth-login",
      loginId: "login-1",
      event: { kind: "secret", promptId: "prompt-1", message: "Enter key" },
    }),
  );
  await waitForWrites(transport, 3);
  expect(decodeClientRequest(transport.writes[2] ?? "").requestId).toBe("auth-response-1");
  transport.data(
    encodeServerFrame({
      schemaVersion: PROTOCOL_VERSION,
      requestId: "auth-response-1",
      type: "error",
      code: "invalid-params",
      message: "Invalid request parameters",
    }),
  );
  await expectPromptRejection(login, "authentication response was rejected");
  expect(transport.destroyCalls).toBe(1);
});

test("prompt cancellation ignores a late value and login accepts subsequent success", async () => {
  const transport = new FakeAuthTransport();
  const latePrompt = Promise.withResolvers<string>();
  const promptCancelled = Promise.withResolvers<void>();
  let promptAborted = false;
  const login = runEffect(
    loginProvider(
      "fixture",
      "anthropic",
      "api_key",
      {
        notify: () => Effect.void,
        prompt(_event, signal) {
          signal.addEventListener(
            "abort",
            () => {
              promptAborted = true;
              promptCancelled.resolve();
            },
            { once: true },
          );
          return Effect.promise(() => latePrompt.promise);
        },
      },
      factory(transport),
    ),
  );
  transport.connect();
  await waitForWrites(transport, 1);
  transport.data(encodeServerFrame(initializeFrame("auth-initialize")));
  await waitForWrites(transport, 2);
  transport.data(
    encodeServerFrame({
      schemaVersion: PROTOCOL_VERSION,
      type: "auth",
      requestId: "auth-login",
      loginId: "login-1",
      event: { kind: "secret", promptId: "prompt-1", message: "Enter key" },
    }),
  );
  transport.data(
    encodeServerFrame({
      schemaVersion: PROTOCOL_VERSION,
      type: "auth",
      requestId: "auth-login",
      loginId: "login-1",
      event: { kind: "prompt_cancelled", promptId: "prompt-1" },
    }),
  );
  await promptCancelled.promise;
  latePrompt.resolve("fixture-value");
  transport.data(encodeServerFrame(loginSuccess()));
  await expect(login).resolves.toEqual({
    providerId: "anthropic",
    configured: true,
    type: "api_key",
    source: "stored",
  });
  expect(promptAborted).toBeTrue();
  expect(
    transport.writes.map((write) => decodeClientRequest(write).method).includes("auth/respond"),
  ).toBeFalse();
});
