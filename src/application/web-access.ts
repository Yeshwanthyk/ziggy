import { Effect } from "effect";
import { openWebAccessStore } from "../adapters/bun/web-access-sqlite";
import { inspectGatewayOwner } from "../adapters/bun/gateway-owner";
import { readUiServerProjection } from "../adapters/bun/ui-server";
import { readWebAccessConfig, writeWebAccessConfig } from "../adapters/fs/web-access-config";
import type { ProfileTarget } from "../domain/profile";
import { WebAccessError, type WebPairing } from "../domain/web-access";

const openStore = (target: ProfileTarget, operation: string) =>
  Effect.try({
    try: () => openWebAccessStore(target.path),
    catch: (cause) =>
      new WebAccessError({
        operation,
        path: target.path,
        message: `could not ${operation}`,
        cause,
      }),
  });

export const configureWebAccess = (
  target: ProfileTarget,
  port: number,
  publicUrl?: string,
): Effect.Effect<void, WebAccessError> =>
  writeWebAccessConfig(
    target.path,
    publicUrl === undefined ? { version: 1, port } : { version: 1, port, publicUrl },
  );

export const issueWebPairing = (target: ProfileTarget): Effect.Effect<WebPairing, WebAccessError> =>
  Effect.gen(function* () {
    const config = yield* readWebAccessConfig(target.path);

    let port = config.port;

    if (port === 0 && config.publicUrl === undefined) {
      const owner = yield* inspectGatewayOwner(target).pipe(
        Effect.mapError(
          (cause) =>
            new WebAccessError({
              operation: "issue web pairing",
              path: target.path,
              message: "could not inspect resident",
              cause,
            }),
        ),
      );

      if (owner._tag === "running") {
        port = (yield* readUiServerProjection(target.path).pipe(
          Effect.mapError(
            (cause) =>
              new WebAccessError({
                operation: "issue web pairing",
                path: target.path,
                message: "resident UI is not ready",
                cause,
              }),
          ),
        )).port;
      }
    }

    if (port === 0 && config.publicUrl === undefined) {
      return yield* new WebAccessError({
        operation: "issue web pairing",
        path: target.path,
        message: `resident must be running to pair with an ephemeral port; start ziggy serve ${JSON.stringify(target.path)} or configure a port with ziggy web configure ${JSON.stringify(target.path)} --port <n>`,
      });
    }

    return yield* Effect.acquireUseRelease(
      openStore(target, "issue web pairing"),
      (store) =>
        Effect.try({
          try: () => {
            const pairing = store.issuePairing();
            const base = config.publicUrl ?? `http://127.0.0.1:${port}`;
            const url = new URL(base);
            url.hash = `code=${pairing.token}`;

            return { url: url.toString(), expiresAt: new Date(pairing.expiresAtMs).toISOString() };
          },
          catch: (cause) =>
            new WebAccessError({
              operation: "issue web pairing",
              path: target.path,
              message: "could not issue web pairing",
              cause,
            }),
        }),
      (store) => Effect.sync(() => store.close()),
    );
  });

export const revokeWebSessions = (target: ProfileTarget): Effect.Effect<number, WebAccessError> =>
  Effect.acquireUseRelease(
    openStore(target, "revoke web sessions"),
    (store) =>
      Effect.try({
        try: () => store.revokeAll(),
        catch: (cause) =>
          new WebAccessError({
            operation: "revoke web sessions",
            path: target.path,
            message: "could not revoke web sessions",
            cause,
          }),
      }),
    (store) => Effect.sync(() => store.close()),
  );
