/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test callbacks are Promise-shaped */
import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import {
  makeChatHandle,
  type ChatEvent,
  type ChatHandle,
  type ZiggyAgentApi,
} from "ziggy/application/agent";
import { makeChatRegistry } from "ziggy/application/chat-registry";
import { makeSharedUiGateway } from "ziggy/application/ui-gateway";
import type { SessionsApi } from "ziggy/application/sessions";
import type {
  ProfileDirectoryApi,
  ProfileDirectoryEntry,
} from "ziggy/application/profile-directory";
import { stableProfileId } from "ziggy/application/profile-directory";
import { SessionNotFound } from "ziggy/domain/session";
import { UiEventFrame, UiResponseFrame } from "ziggy/domain/ui-gateway";
import type { ProfileTarget } from "ziggy/domain/profile";
import type { ProfileExtensionsApi } from "ziggy/domain/profile-extension";
import { UnknownProfile } from "ziggy/domain/profile-directory";

const alphaTarget = { path: "/private/alpha", name: "Alpha" } satisfies ProfileTarget;
const betaTarget = { path: "/private/beta", name: "Beta" } satisfies ProfileTarget;
const alphaId = stableProfileId(alphaTarget.path);
const betaId = stableProfileId(betaTarget.path);
const decodeResponse = Schema.decodeUnknownResult(Schema.fromJsonString(UiResponseFrame));
const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(UiEventFrame));

const makeDirectory = (): ProfileDirectoryApi => {
  const entries = [
    {
      profileId: alphaId,
      name: alphaTarget.name,
      current: true,
      available: true,
      target: alphaTarget,
    },
    {
      profileId: betaId,
      name: betaTarget.name,
      current: false,
      available: true,
      target: betaTarget,
    },
  ] satisfies ReadonlyArray<ProfileDirectoryEntry>;
  return {
    entries: () => Effect.succeed(entries),
    list: () =>
      Effect.succeed(
        entries.map(({ profileId, name, current, available }) => ({
          profileId,
          name,
          current,
          available,
        })),
      ),
    current: () => Effect.succeed({ profileId: alphaId, target: alphaTarget }),
    resolve: (profileId) => {
      const entry = entries.find((candidate) => candidate.profileId === profileId);
      return entry === undefined
        ? Effect.fail(new UnknownProfile({ profileId }))
        : Effect.succeed({ profileId: entry.profileId, target: entry.target });
    },
  };
};

const makeSessions = (): SessionsApi => ({
  list: () => Effect.succeed([]),
  show: (_target, reference) => Effect.fail(new SessionNotFound({ reference, message: "missing" })),
  resolve: (_target, reference) =>
    Effect.fail(new SessionNotFound({ reference, message: "missing" })),
});

const makeExtensions = (): ProfileExtensionsApi => ({
  list: () => Effect.succeed([]),
  show: () => Effect.never,
  listForProfile: () => Effect.succeed({ available: [], selected: [] }),
  add: (_target, _repositoryRoot, id) =>
    Effect.succeed({ id, profilePath: "", changed: true, selected: true }),
  remove: (_target, _repositoryRoot, id) =>
    Effect.succeed({ id, profilePath: "", changed: true, selected: false }),
  setSelected: () => Effect.never,
  validate: () =>
    Effect.succeed({
      selected: [],
      preflight: { extensionPathCount: 0, skillPathCount: 0, extensionFactoryCount: 0 },
    }),
  prepareRuntime: () => Effect.never,
  activateRuntime: () => Effect.never,
});

const eventFrames = (frames: ReadonlyArray<string>) =>
  frames.flatMap((frame) => {
    const decoded = decodeEvent(frame);
    return Result.isSuccess(decoded) ? [decoded.success] : [];
  });

test("shared UI gateway isolates two Profile branches and watch streams", async () => {
  const openedPaths: string[] = [];
  const handles = new Map<string, ChatHandle>();
  const handleFor = (label: string): ChatHandle => {
    const listeners = new Set<(event: ChatEvent) => void>();
    return makeChatHandle({
      prompt: (text) =>
        Effect.sync(() => {
          const snapshot = `${label}:${text}`;
          for (const listener of listeners)
            listener({ kind: "assistant-text", delta: snapshot, snapshot });
          return snapshot;
        }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
  };
  const alphaHandle = handleFor("alpha");
  const betaHandle = handleFor("beta");
  handles.set(alphaTarget.path, alphaHandle);
  handles.set(betaTarget.path, betaHandle);
  const agent: ZiggyAgentApi = {
    runOnce: () => Effect.succeed(0),
    openTui: () => Effect.succeed(0),
    openChat: (target) => {
      openedPaths.push(target.path);
      const handle = handles.get(target.path);
      return handle === undefined ? Effect.never : Effect.succeed(handle);
    },
    openSpecialistChat: () => Effect.succeed(alphaHandle),
    runSpecialist: () => Effect.succeed({ answer: "", session: { id: "child", file: "child" } }),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const alphaRegistry = yield* makeChatRegistry();
        const betaRegistry = yield* makeChatRegistry();
        const gateway = makeSharedUiGateway({
          profileDirectory: makeDirectory(),
          defaultProfile: { profileId: alphaId, target: alphaTarget, registry: alphaRegistry },
          branches: [
            { profileId: alphaId, target: alphaTarget, registry: alphaRegistry },
            { profileId: betaId, target: betaTarget, registry: betaRegistry },
          ],
          repositoryRoot: "/private/repository",
          sessions: makeSessions(),
          agent,
          profileExtensions: makeExtensions(),
        });
        const commandFrames: string[] = [];
        const command = gateway.connect((frame) => commandFrames.push(frame));
        const alphaWatchFrames: string[] = [];
        const betaWatchFrames: string[] = [];
        const alphaWatch = gateway.connect((frame) => alphaWatchFrames.push(frame));
        const betaWatch = gateway.connect((frame) => betaWatchFrames.push(frame));
        const alphaRef = { profileId: alphaId, kind: "live" as const, key: "ui/alpha" };
        const betaRef = { profileId: betaId, kind: "live" as const, key: "ui/beta" };

        yield* command.request({
          id: "open-alpha",
          method: "session.open",
          params: { profileId: alphaId, context: { kind: "local" }, name: "alpha" },
        });
        yield* command.request({
          id: "open-beta",
          method: "session.open",
          params: { profileId: betaId, context: { kind: "local" }, name: "beta" },
        });
        yield* alphaWatch.request({
          id: "watch-alpha",
          method: "session.watch",
          params: { ref: alphaRef, afterSeq: 0 },
        });
        yield* betaWatch.request({
          id: "watch-beta",
          method: "session.watch",
          params: { ref: betaRef, afterSeq: 0 },
        });
        yield* command.request({
          id: "prompt-alpha",
          method: "prompt.submit",
          params: { ref: alphaRef, text: "one" },
        });
        yield* command.request({
          id: "prompt-beta",
          method: "prompt.submit",
          params: { ref: betaRef, text: "two" },
        });
        yield* Effect.yieldNow;

        expect(openedPaths).toEqual([alphaTarget.path, betaTarget.path]);
        expect(eventFrames(alphaWatchFrames)).toHaveLength(1);
        expect(eventFrames(betaWatchFrames)).toHaveLength(1);
        expect(eventFrames(alphaWatchFrames)[0]).toMatchObject({ profileId: alphaId, seq: 1 });
        expect(eventFrames(betaWatchFrames)[0]).toMatchObject({ profileId: betaId, seq: 1 });
        expect(eventFrames(alphaWatchFrames)[0]?.payload).toMatchObject({ delta: "alpha:one" });
        expect(eventFrames(betaWatchFrames)[0]?.payload).toMatchObject({ delta: "beta:two" });

        yield* command.request({
          id: "list-alpha",
          method: "session.list",
          params: { profileId: alphaId },
        });
        yield* command.request({
          id: "list-beta",
          method: "session.list",
          params: { profileId: betaId },
        });
        const responses = commandFrames.flatMap((frame) => {
          const decoded = decodeResponse(frame);
          return Result.isSuccess(decoded) ? [decoded.success] : [];
        });
        const alphaList = responses.find((response) => response.id === "list-alpha");
        const betaList = responses.find((response) => response.id === "list-beta");
        expect(alphaList).toMatchObject({
          ok: true,
          result: { profileId: alphaId, live: [{ ref: alphaRef }] },
        });
        expect(betaList).toMatchObject({
          ok: true,
          result: { profileId: betaId, live: [{ ref: betaRef }] },
        });

        yield* command.request({
          id: "close-alpha",
          method: "session.close",
          params: { ref: alphaRef },
        });
        yield* command.request({
          id: "list-beta-after-alpha-close",
          method: "session.list",
          params: { profileId: betaId },
        });
        expect(
          commandFrames
            .flatMap((frame) => {
              const decoded = decodeResponse(frame);
              return Result.isSuccess(decoded) ? [decoded.success] : [];
            })
            .at(-1),
        ).toMatchObject({
          id: "list-beta-after-alpha-close",
          ok: true,
          result: { profileId: betaId, live: [{ ref: betaRef }] },
        });
        expect(
          JSON.stringify([...commandFrames, ...alphaWatchFrames, ...betaWatchFrames]),
        ).not.toContain(alphaTarget.path);
        expect(
          JSON.stringify([...commandFrames, ...alphaWatchFrames, ...betaWatchFrames]),
        ).not.toContain(betaTarget.path);
      }),
    ),
  );
});
