import type {
  ExtensionDoctorResponse,
  ExtensionEnableResponse,
  ExtensionInstallResponse,
  ExtensionObservation,
  SessionSummary,
} from "@ziggy/protocol";
import { ZIGGY_VERSION } from "@ziggy/core";
import { Effect, Schema } from "effect";
import {
  createAttachClient,
  type AcceptedTurn,
  type AttachClient,
  type AttachClientError,
} from "./attach-client.ts";
import { unixAttachTransportFactory } from "./attach-transport.ts";
import type { DaemonControlError, DaemonProbeResult } from "./daemon.ts";
import { runTuiWithClient, type TuiHostFactory } from "./tui-client.ts";

export class CliClientSetupError extends Schema.TaggedErrorClass<CliClientSetupError>()(
  "CliClientSetupError",
  { message: Schema.String },
) {}

export class CliTurnFailedError extends Schema.TaggedErrorClass<CliTurnFailedError>()(
  "CliTurnFailedError",
  { status: Schema.Literals(["failed", "interrupted"]) },
) {}

export class CliOutcomeUnknownError extends Schema.TaggedErrorClass<CliOutcomeUnknownError>()(
  "CliOutcomeUnknownError",
  {},
) {}

export type CliClientError =
  | AttachClientError
  | CliClientSetupError
  | CliOutcomeUnknownError
  | CliTurnFailedError
  | DaemonControlError;

export interface CliDaemonSetup<R = never> {
  readonly probe: (profilePath: string) => Effect.Effect<DaemonProbeResult, DaemonControlError, R>;
  readonly startAbsent: (
    profilePath: string,
  ) => Effect.Effect<DaemonProbeResult, DaemonControlError, R>;
}

export type ExtensionClientRequest =
  | {
      readonly action: "install";
      readonly sourcePath: string;
      readonly approvals: ReadonlyArray<string>;
      readonly verification?: { readonly keyId: string; readonly signature: string };
    }
  | {
      readonly action: "enable";
      readonly extensionId: string;
      readonly approvals: ReadonlyArray<string>;
    }
  | { readonly action: "disable"; readonly extensionId: string }
  | { readonly action: "list" }
  | { readonly action: "doctor"; readonly extensionId: string; readonly approval?: string };

export type ExtensionClientResult =
  | ExtensionDoctorResponse
  | ExtensionEnableResponse
  | ExtensionInstallResponse
  | ExtensionObservation
  | ReadonlyArray<ExtensionObservation>;

export function prepareClientDaemon<R>(
  profilePath: string,
  setup: CliDaemonSetup<R>,
): Effect.Effect<
  Extract<DaemonProbeResult, { readonly status: "ready" }>,
  DaemonControlError | CliClientSetupError,
  R
> {
  return Effect.gen(function* () {
    const initial = yield* setup.probe(profilePath);
    if (initial.status === "ready") return initial;
    if (initial.status !== "unavailable" || initial.socketState !== "absent") {
      return yield* new CliClientSetupError({
        message: "Profile daemon is not available for safe auto-start",
      });
    }
    const started = yield* setup.startAbsent(initial.profilePath);
    if (started.status !== "ready") {
      return yield* new CliClientSetupError({
        message: "Profile daemon did not become ready",
      });
    }
    return started;
  });
}

export function runAskWithClient<E, R>(
  client: AttachClient,
  prompt: string,
  writeStdout: (text: string) => Effect.Effect<void, E, R>,
): Effect.Effect<void, AttachClientError | CliOutcomeUnknownError | CliTurnFailedError | E, R> {
  return client.startMainTurn(prompt).pipe(
    Effect.flatMap((accepted) => streamAcceptedTurn(accepted, writeStdout)),
    Effect.catchTag("AttachOutcomeUnknownError", () => new CliOutcomeUnknownError()),
  );
}

export function runSessionsListWithClient(
  client: AttachClient,
): Effect.Effect<string, AttachClientError> {
  return client.listSessions.pipe(Effect.map(formatSessionList));
}

function runExtensionWithClient(
  client: AttachClient,
  request: ExtensionClientRequest,
): Effect.Effect<ExtensionClientResult, AttachClientError> {
  switch (request.action) {
    case "install":
      return client.installExtension({
        sourcePath: request.sourcePath,
        approvals: request.approvals,
        ...(request.verification === undefined ? {} : { verification: request.verification }),
      });
    case "enable":
      return client.enableExtension({
        extensionId: request.extensionId,
        approvals: request.approvals,
      });
    case "disable":
      return client.disableExtension(request.extensionId);
    case "list":
      return client.listExtensions;
    case "doctor":
      return client.doctorExtension({
        extensionId: request.extensionId,
        ...(request.approval === undefined ? {} : { approval: request.approval }),
      });
  }
}

export function runProductionAsk<E, SetupR, OutputR>(
  profilePath: string,
  prompt: string,
  setup: CliDaemonSetup<SetupR>,
  writeStdout: (text: string) => Effect.Effect<void, E, OutputR>,
): Effect.Effect<void, CliClientError | E, SetupR | OutputR> {
  return Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* prepareClientDaemon(profilePath, setup);
      const client = yield* createAttachClient({
        transport: unixAttachTransportFactory(ready.socketPath),
        client: { name: "ziggy-ask", version: ZIGGY_VERSION, features: ["modelChunks"] },
      });
      yield* runAskWithClient(client, prompt, writeStdout);
    }),
  );
}

export function runProductionTui<R>(
  profilePath: string,
  setup: CliDaemonSetup<R>,
  hostFactory?: TuiHostFactory,
): Effect.Effect<void, CliClientError, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* prepareClientDaemon(profilePath, setup);
      const client = yield* createAttachClient({
        transport: unixAttachTransportFactory(ready.socketPath),
        client: { name: "ziggy-tui", version: ZIGGY_VERSION, features: ["modelChunks"] },
      });
      yield* hostFactory === undefined
        ? runTuiWithClient(client)
        : runTuiWithClient(client, hostFactory);
    }),
  );
}

export function runProductionSessionsList<R>(
  profilePath: string,
  setup: CliDaemonSetup<R>,
): Effect.Effect<string, CliClientError, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* prepareClientDaemon(profilePath, setup);
      const client = yield* createAttachClient({
        transport: unixAttachTransportFactory(ready.socketPath),
        client: { name: "ziggy-sessions", version: ZIGGY_VERSION },
      });
      return yield* runSessionsListWithClient(client);
    }),
  );
}

export function runProductionExtension<R>(
  profilePath: string,
  request: ExtensionClientRequest,
  setup: CliDaemonSetup<R>,
): Effect.Effect<ExtensionClientResult, CliClientError, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* prepareClientDaemon(profilePath, setup);
      const client = yield* createAttachClient({
        transport: unixAttachTransportFactory(ready.socketPath),
        client: { name: "ziggy-extension", version: ZIGGY_VERSION },
        requiredFeatures: ["extensionLifecycle"],
      });
      return yield* runExtensionWithClient(client, request);
    }),
  );
}

export function formatSessionList(sessions: ReadonlyArray<SessionSummary>): string {
  return JSON.stringify(
    [...sessions]
      .sort((left, right) => {
        const created = left.createdAt.localeCompare(right.createdAt);
        return created === 0 ? left.sessionId.localeCompare(right.sessionId) : created;
      })
      .map((session) => ({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        status: session.activeTurnId === undefined ? "idle" : "active",
      })),
  );
}

function streamAcceptedTurn<E, R>(
  accepted: AcceptedTurn,
  writeStdout: (text: string) => Effect.Effect<void, E, R>,
): Effect.Effect<void, AttachClientError | CliOutcomeUnknownError | CliTurnFailedError | E, R> {
  return Effect.gen(function* () {
    let trailingLineBreaks = "";
    while (true) {
      const envelope = yield* accepted.subscription.next.pipe(
        Effect.catch(() => new CliOutcomeUnknownError()),
      );
      const event = envelope.event;
      if (
        event.type === "model-chunk" &&
        event.turnId === accepted.acceptance.turnId &&
        event.kind === "text"
      ) {
        const combined = trailingLineBreaks + event.delta;
        let boundary = combined.length;
        while (boundary > 0) {
          const character = combined[boundary - 1];
          if (character !== "\n" && character !== "\r") break;
          boundary -= 1;
        }
        const stable = combined.slice(0, boundary);
        trailingLineBreaks = combined.slice(boundary);
        if (stable.length > 0) yield* writeStdout(stable);
        continue;
      }
      if (event.type !== "turn-ended" || event.turnId !== accepted.acceptance.turnId) continue;
      if (event.status !== "completed") {
        return yield* new CliTurnFailedError({ status: event.status });
      }
      yield* writeStdout("\n");
      return;
    }
  });
}
