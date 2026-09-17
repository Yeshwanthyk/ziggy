/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures exercise the Node filesystem adapter */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { makeAutomationRunStore, readAutomationRuns } from "ziggy/adapters/bun/automation-sqlite";
import { automationFileStore } from "ziggy/adapters/fs/automation-files";
import { listProfileSessions, showProfileSession } from "ziggy/adapters/pi/sessions";
import { readSessionHistory } from "ziggy/adapters/pi/session-history";
import { makeChatHandle, type ZiggyAgentApi } from "ziggy/application/agent";
import { type AutomationCapabilities, makeAutomations } from "ziggy/application/automations";
import { makeChatRegistry } from "ziggy/application/chat-registry";
import {
  stableProfileId,
  type ProfileDirectoryApi,
  type ProfileDirectoryEntry,
} from "ziggy/application/profile-directory";
import type { SessionsApi } from "ziggy/application/sessions";
import { makeSharedUiGateway, makeUiGateway } from "ziggy/application/ui-gateway";
import { SessionNotFound } from "ziggy/domain/session";
import type { ProfileExtensionsApi } from "ziggy/domain/profile-extension";
import type { ProfileTarget } from "ziggy/domain/profile";
import { UnknownProfile } from "ziggy/domain/profile-directory";
import { UiResponseFrame } from "ziggy/domain/ui-gateway";

const roots: string[] = [];

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(UiResponseFrame));

const profileExtensions: ProfileExtensionsApi = {
  list: () => Effect.never,
  show: () => Effect.never,
  listForProfile: () => Effect.succeed({ available: [], selected: [] }),
  add: () => Effect.never,
  remove: () => Effect.never,
  setSelected: () => Effect.never,
  validate: () =>
    Effect.succeed({
      selected: [],
      preflight: { extensionPathCount: 0, skillPathCount: 0, extensionFactoryCount: 0 },
    }),
  prepareRuntime: () => Effect.never,
  activateRuntime: () => Effect.never,
};

const sessions: SessionsApi = {
  list: (target) => listProfileSessions(target.path),
  show: (target, reference) => showProfileSession(target.path, reference),
  resolve: (target, id) =>
    Effect.gen(function* () {
      const listed = yield* listProfileSessions(target.path);
      const session = listed.find((candidate) => candidate.id === id);

      if (session !== undefined) return session;

      return yield* new SessionNotFound({ reference: id, message: `session not found: ${id}` });
    }),
  history: (target, reference, before) => readSessionHistory(target.path, reference, before),
};

const definition = (broadcast: string) =>
  [
    "---",
    "version: 1",
    "cron: 0 9 * * *",
    "timezone: UTC",
    `broadcast: ${broadcast}`,
    "---",
    "Write the daily note.",
    "",
  ].join("\n");

const makeProfile = async (broadcast: string): Promise<ProfileTarget> => {
  const path = await mkdtemp(join(tmpdir(), "ziggy-automation-ui-"));
  roots.push(path);
  await mkdir(join(path, "automations"));
  await writeFile(join(path, "SOUL.md"), "# Test\n");
  await writeFile(join(path, "automations", "daily-note.md"), definition(broadcast));

  return { path, name: "Test" };
};

const capabilities: AutomationCapabilities = {
  gate: { run: () => Effect.succeed({ kind: "passed" }) },
  files: automationFileStore,
  printReply: () => Effect.void,
  loadTelegramConfig: () => Effect.never,
  loadDiscordConfig: () => Effect.never,
  loadSlackConfig: () => Effect.never,
  sendTelegram: () => Effect.never,
  sendDiscord: () => Effect.never,
  sendSlack: () => Effect.never,
};

const makeFixture = async (broadcast: string) => {
  const target = await makeProfile(broadcast);
  const profileId = stableProfileId(target.path);
  const opened: Array<{ context: string; directory: string; mode: string | undefined }> = [];
  const prompts: string[] = [];

  const agent: ZiggyAgentApi = {
    runOnce: () => Effect.succeed(0),
    openTui: () => Effect.succeed(0),
    openChat: (_target, context, directory, mode) =>
      Effect.sync(() => {
        opened.push({ context: context.kind, directory, mode });

        return makeChatHandle({
          prompt: (prompt) =>
            Effect.sync(() => {
              prompts.push(prompt);

              return "The durable result";
            }),
        });
      }),
    openSpecialistChat: () =>
      Effect.succeed(makeChatHandle({ prompt: () => Effect.succeed("unused") })),
    runSpecialist: () =>
      Effect.succeed({ answer: "unused", session: { id: "unused", file: "unused.jsonl" } }),
  };

  const automations = makeAutomations(agent, capabilities, {
    store: makeAutomationRunStore(process.pid, `test-owner-${profileId}`),
    now: Effect.succeed(1_000),
    makeManualRunId: () => "manual:00000000-0000-4000-8000-000000000001",
  });

  return { target, profileId, agent, automations, opened, prompts };
};

const makeProfileDirectory = (
  current: {
    readonly profileId: ReturnType<typeof stableProfileId>;
    readonly target: ProfileTarget;
  },
  others: ReadonlyArray<{
    readonly profileId: ReturnType<typeof stableProfileId>;
    readonly target: ProfileTarget;
  }>,
): ProfileDirectoryApi => {
  const profiles = [current, ...others];

  const entries = profiles.map(
    ({ profileId, target }, index): ProfileDirectoryEntry => ({
      profileId,
      target,
      name: target.name,
      current: index === 0,
      available: true,
    }),
  );

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
    current: () => Effect.succeed(current),
    resolve: (profileId) => {
      const profile = profiles.find((candidate) => candidate.profileId === profileId);

      return profile === undefined
        ? Effect.fail(new UnknownProfile({ profileId }))
        : Effect.succeed(profile);
    },
  };
};

const request = (
  gateway: ReturnType<typeof makeUiGateway>,
  input: Parameters<ReturnType<typeof gateway.connect>["request"]>[0],
) =>
  Effect.gen(function* () {
    const frames: string[] = [];
    const connection = gateway.connect((frame) => frames.push(frame));
    yield* connection.request(input);
    yield* connection.close;

    return decodeResponse(frames.at(-1) ?? "null");
  });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("automation.run routes through the selected Profile registry and reloads the durable result", async () => {
  const fixture = await makeFixture("conversation:pinned-session");
  const defaultTarget = await makeProfile("none");
  const defaultProfileId = stableProfileId(defaultTarget.path);

  const manager = SessionManager.create(
    fixture.target.path,
    join(fixture.target.path, "sessions", "ui"),
    { id: "pinned-session" },
  );

  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "before" }],
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ready" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
  expect(
    (await Effect.runPromise(listProfileSessions(fixture.target.path))).map((item) => item.id),
  ).toContain("pinned-session");

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const defaultRegistry = yield* makeChatRegistry(defaultTarget.path);
        const registry = yield* makeChatRegistry(fixture.target.path);

        const profileDirectory = makeProfileDirectory(
          { profileId: defaultProfileId, target: defaultTarget },
          [{ profileId: fixture.profileId, target: fixture.target }],
        );

        const gateway = makeSharedUiGateway({
          defaultProfile: {
            profileId: defaultProfileId,
            target: defaultTarget,
            registry: defaultRegistry,
          },
          branches: [
            { profileId: defaultProfileId, target: defaultTarget, registry: defaultRegistry },
            { profileId: fixture.profileId, target: fixture.target, registry },
          ],
          profileDirectory,
          repositoryRoot: fixture.target.path,
          sessions,
          agent: fixture.agent,
          profileExtensions,
          automations: fixture.automations,
        });

        const runResponse = yield* request(gateway, {
          id: "run",
          method: "automation.run",
          params: { profileId: fixture.profileId, automationId: "daily-note" },
        });

        expect(runResponse).toMatchObject({
          id: "run",
          ok: true,
          result: {
            profileId: fixture.profileId,
            automationId: "daily-note",
            accepted: true,
            outcome: "executed",
          },
        });
        expect((yield* readAutomationRuns(fixture.target.path))[0]).toMatchObject({
          state: "completed",
          localCompleted: true,
        });
        expect((yield* listProfileSessions(defaultTarget.path)).map((item) => item.id)).toEqual([]);

        const restartedDefaultRegistry = yield* makeChatRegistry(defaultTarget.path);
        const restartedRegistry = yield* makeChatRegistry(fixture.target.path);

        const restartedGateway = makeSharedUiGateway({
          defaultProfile: {
            profileId: defaultProfileId,
            target: defaultTarget,
            registry: restartedDefaultRegistry,
          },
          branches: [
            {
              profileId: defaultProfileId,
              target: defaultTarget,
              registry: restartedDefaultRegistry,
            },
            {
              profileId: fixture.profileId,
              target: fixture.target,
              registry: restartedRegistry,
            },
          ],
          profileDirectory,
          repositoryRoot: fixture.target.path,
          sessions,
          agent: fixture.agent,
          profileExtensions,
          automations: fixture.automations,
        });

        const historyResponse = yield* request(restartedGateway, {
          id: "history",
          method: "session.history",
          params: {
            ref: { profileId: fixture.profileId, kind: "stored", id: "pinned-session" },
          },
        });

        expect(historyResponse).toMatchObject({
          id: "history",
          ok: true,
          result: {
            profileId: fixture.profileId,
            entries: expect.arrayContaining([
              {
                kind: "automation-result",
                automationId: "daily-note",
                runId: "manual:00000000-0000-4000-8000-000000000001",
                text: "Automation daily-note result (run manual:00000000-0000-4000-8000-000000000001):\nThe durable result",
                timestamp: expect.any(String),
              },
            ]),
          },
        });
      }),
    ),
  );

  expect(fixture.opened).toEqual([
    {
      context: "local",
      directory: join(fixture.target.path, "sessions", "automations", "daily-note"),
      mode: "fresh",
    },
  ]);
  expect(fixture.prompts).toEqual(["Write the daily note."]);
});

test("a missing destination records a terminal failure without a fallback conversation", async () => {
  const fixture = await makeFixture("conversation:deleted-session");

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeChatRegistry(fixture.target.path);

        const gateway = makeUiGateway({
          defaultProfile: { profileId: fixture.profileId, target: fixture.target, registry },
          repositoryRoot: fixture.target.path,
          sessions,
          agent: fixture.agent,
          profileExtensions,
          automations: fixture.automations,
        });

        const response = yield* request(gateway, {
          id: "missing",
          method: "automation.run",
          params: { profileId: fixture.profileId, automationId: "daily-note" },
        });

        expect(response).toMatchObject({
          id: "missing",
          ok: true,
          result: { accepted: true, outcome: "executed" },
        });
      }),
    ),
  );

  expect((await Effect.runPromise(readAutomationRuns(fixture.target.path)))[0]).toMatchObject({
    state: "failed",
    localCompleted: true,
    failureCategory: "destination-missing",
    targets: [
      {
        target: "conversation:deleted-session",
        status: "failed",
        failureCategory: "destination-missing",
        retriable: false,
      },
    ],
  });
  expect(fixture.prompts).toEqual(["Write the daily note."]);
});
