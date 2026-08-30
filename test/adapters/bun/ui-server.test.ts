/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Result } from "effect";
import {
  openUiServer,
  readUiServerProjection,
  UI_SERVER_BACKPRESSURE_BYTES,
  UI_SERVER_MAX_FRAME_BYTES,
  UI_SERVER_MAX_IN_FLIGHT,
  uiServerProjectionPath,
  type UiServerHandlers,
} from "ziggy/adapters/bun/ui-server";

const paths: Array<string> = [];

const makeProfile = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-ui-server-"));
  paths.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const within = <Value>(promise: Promise<Value>, label: string): Promise<Value> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_000),
    ),
  ]);

const handlers = (overrides: Partial<UiServerHandlers> = {}): UiServerHandlers => ({
  onRequest: (connection, request) =>
    Effect.sync(() => connection.send(JSON.stringify({ id: request.id, ok: true, result: {} }))),
  onClose: () => Effect.void,
  ...overrides,
});

const waitForOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
      once: true,
    });
  });

const connect = async (port: number, token: string): Promise<WebSocket> => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await within(waitForOpen(socket), "socket open");
  return socket;
};

const nextMessage = (socket: WebSocket): Promise<string> =>
  new Promise((resolve) => {
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
  });

const nextClose = (socket: WebSocket): Promise<CloseEvent> =>
  new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));

const closeClient = async (socket: WebSocket): Promise<void> => {
  if (socket.readyState >= WebSocket.CLOSING) return;
  const closed = nextClose(socket);
  socket.close();
  await within(closed, "client close");
};

describe("Bun UI server projection and authentication", () => {
  test("replaces stale discovery and publishes a strict 0600 projection", async () => {
    const profilePath = await makeProfile();
    const runtimePath = join(profilePath, ".runtime");
    const path = uiServerProjectionPath(profilePath);
    await mkdir(runtimePath);
    await writeFile(path, '{"version":1,"port":1,"token":"stale"}\n');
    await chmod(path, 0o644);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openUiServer(profilePath, handlers());
          const projection = yield* readUiServerProjection(profilePath);
          expect(projection.port).toBe(server.port);
          expect(projection.token).toMatch(/^[0-9a-f]{64}$/u);
          expect((yield* Effect.promise(() => lstat(path))).mode & 0o777).toBe(0o600);
          expect(UI_SERVER_MAX_FRAME_BYTES).toBe(64 * 1024);
          expect(UI_SERVER_BACKPRESSURE_BYTES).toBe(256 * 1024);
          expect(UI_SERVER_MAX_IN_FLIGHT).toBe(16);
        }),
      ),
    );

    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("requires a matching query or Bearer token before upgrade", async () => {
    const profilePath = await makeProfile();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openUiServer(profilePath, handlers());
          const { token } = yield* readUiServerProjection(profilePath);
          const base = `http://127.0.0.1:${server.port}/ws`;

          expect((yield* Effect.promise(() => fetch(base))).status).toBe(401);
          expect(
            (yield* Effect.promise(() => fetch(`${base}?token=${"0".repeat(64)}`))).status,
          ).toBe(401);
          expect(
            (yield* Effect.promise(() =>
              fetch(`${base}?token=${token}`, {
                headers: { Authorization: `Bearer ${"0".repeat(64)}` },
              }),
            )).status,
          ).toBe(401);
          expect(
            (yield* Effect.promise(() =>
              fetch(base, { headers: { Authorization: `Bearer ${token}` } }),
            )).status,
          ).toBe(400);

          const querySocket = yield* Effect.promise(() => connect(server.port, token));
          yield* Effect.promise(() => closeClient(querySocket));
          const bearerSocket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          yield* Effect.promise(() => within(waitForOpen(bearerSocket), "Bearer socket open"));
          yield* Effect.promise(() => closeClient(bearerSocket));
          const bothSocket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          yield* Effect.promise(() => within(waitForOpen(bothSocket), "dual-auth socket open"));
          yield* Effect.promise(() => closeClient(bothSocket));
        }),
      ),
    );
  });

  test("keeps a replacement projection whose token belongs to another server", async () => {
    const profilePath = await makeProfile();
    const path = uiServerProjectionPath(profilePath);
    const replacement = {
      version: 1,
      port: 31337,
      token: "f".repeat(64),
    } as const;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* openUiServer(profilePath, handlers());
          yield* Effect.promise(() =>
            writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 }),
          );
        }),
      ),
    );

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
  });

  test("rejects a symlinked runtime directory without writing through it", async () => {
    const profilePath = await makeProfile();
    const external = await makeProfile();
    await symlink(external, join(profilePath, ".runtime"));

    const result = await Effect.runPromise(
      Effect.scoped(openUiServer(profilePath, handlers()).pipe(Effect.result)),
    );

    expect(Result.isFailure(result) && result.failure.operation).toBe("write");
    expect(await Bun.file(join(external, "ui-server.json")).exists()).toBe(false);
  });
});

describe("Bun UI server socket lifecycle", () => {
  test("maps an oversized outgoing response to a bounded typed failure", async () => {
    const profilePath = await makeProfile();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openUiServer(
            profilePath,
            handlers({
              onRequest: (connection, request) =>
                Effect.sync(() =>
                  connection.send(
                    JSON.stringify({
                      id: request.id,
                      ok: true,
                      result: { source: "\n".repeat(UI_SERVER_MAX_FRAME_BYTES) },
                    }),
                  ),
                ),
            }),
          );
          const { token } = yield* readUiServerProjection(profilePath);
          const socket = yield* Effect.promise(() => connect(server.port, token));
          const response = nextMessage(socket);
          socket.send(JSON.stringify({ id: "large", method: "ping", params: {} }));
          expect(
            JSON.parse(yield* Effect.promise(() => within(response, "bounded response"))),
          ).toEqual({
            id: "large",
            ok: false,
            error: { code: "internal", message: "response exceeded frame limit" },
          });
          yield* Effect.promise(() => closeClient(socket));
        }),
      ),
    );
  });

  test("rejects binary frames and invokes connection cleanup", async () => {
    const profilePath = await makeProfile();
    let requests = 0;
    const cleaned = await Effect.runPromise(Deferred.make<void>());

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openUiServer(
            profilePath,
            handlers({
              onRequest: () => Effect.sync(() => requests++).pipe(Effect.asVoid),
              onClose: () => Deferred.succeed(cleaned, undefined).pipe(Effect.asVoid),
            }),
          );
          const { token } = yield* readUiServerProjection(profilePath);
          const socket = yield* Effect.promise(() => connect(server.port, token));
          const closed = nextClose(socket);
          socket.send(new Uint8Array([1, 2, 3]));
          expect((yield* Effect.promise(() => within(closed, "binary-frame close"))).code).toBe(
            1003,
          );
          yield* Deferred.await(cleaned).pipe(Effect.timeout("1 second"));
        }),
      ),
    );

    expect(requests).toBe(0);
  });

  test("rejects a duplicate active id while leaving the first handler admitted", async () => {
    const profilePath = await makeProfile();
    let requests = 0;
    const interrupted = await Effect.runPromise(Deferred.make<void>());

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openUiServer(
            profilePath,
            handlers({
              onRequest: () =>
                Effect.sync(() => requests++).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(interrupted, undefined)),
                ),
            }),
          );
          const { token } = yield* readUiServerProjection(profilePath);
          const socket = yield* Effect.promise(() => connect(server.port, token));
          const duplicate = nextMessage(socket);
          const frame = JSON.stringify({ id: "same", method: "ping", params: {} });
          socket.send(frame);
          socket.send(frame);
          expect(
            JSON.parse(yield* Effect.promise(() => within(duplicate, "duplicate response"))),
          ).toEqual({
            id: "same",
            ok: false,
            error: { code: "bad_params", message: "duplicate active request id" },
          });
          expect(requests).toBe(1);
          yield* Effect.promise(() => closeClient(socket));
          yield* Deferred.await(interrupted);
        }),
      ),
    );
  });

  test("closes on request overflow and interrupts only socket-owned request fibers", async () => {
    const profilePath = await makeProfile();
    let interrupted = 0;
    let cleaned = 0;
    const started = await Effect.runPromise(Deferred.make<void>());

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openUiServer(
            profilePath,
            handlers({
              onRequest: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Effect.sync(() => interrupted++)),
                ),
              onClose: () => Effect.sync(() => cleaned++),
            }),
          );
          const { token } = yield* readUiServerProjection(profilePath);
          const socket = yield* Effect.promise(() => connect(server.port, token));
          const closed = nextClose(socket);
          socket.send(JSON.stringify({ id: "r0", method: "ping", params: {} }));
          yield* Deferred.await(started);
          for (let index = 1; index <= UI_SERVER_MAX_IN_FLIGHT; index++) {
            socket.send(JSON.stringify({ id: `r${index}`, method: "ping", params: {} }));
          }
          expect((yield* Effect.promise(() => within(closed, "request-overflow close"))).code).toBe(
            1013,
          );
          yield* Effect.sleep("10 millis");
          expect(cleaned).toBe(1);
          expect(interrupted).toBeGreaterThan(0);
        }),
      ),
    );
  });

  test("fails closed when the bounded callback queue overflows", async () => {
    const profilePath = await makeProfile();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openUiServer(
            profilePath,
            handlers({ onRequest: () => Effect.never }),
            {
              commandCapacity: 1,
              maxInFlightPerSocket: 1_000,
            },
          );
          const { token } = yield* readUiServerProjection(profilePath);
          const socket = yield* Effect.promise(() => connect(server.port, token));
          const closed = nextClose(socket);
          for (let index = 0; index < 128; index++) {
            socket.send(JSON.stringify({ id: `q${index}`, method: "ping", params: {} }));
          }
          expect((yield* Effect.promise(() => within(closed, "queue-overflow close"))).code).toBe(
            1013,
          );
        }),
      ),
    );
  });
});
