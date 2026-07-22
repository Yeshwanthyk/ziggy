import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";
import {
  createFauxCore,
  createModels,
  createProvider,
  fauxAssistantMessage,
  type AuthInteraction,
} from "@earendil-works/pi-ai";
import {
  createAttachServer,
  computeTreeDigest,
  createFilesystemWorld,
  createProfileCredentialStore,
  createProviderRuntimeComposition,
  type DaemonAuthService,
  type DaemonKernel,
  type ProviderRuntimeConfig,
  ProviderRuntimeError,
} from "../../packages/core/src/index.ts";
import {
  decodeServerFrame,
  encodeClientRequest,
  type ClientRequestFrame,
  type ServerFrame,
  type SessionSummary,
} from "../../packages/protocol/src/index.ts";
import { loginProvider, queryProviderAuthStatus } from "../../packages/ziggy/src/auth-client.ts";
import { runEffect } from "../testkit/effect.ts";

const profiles: string[] = [];
const canary = "auth-secret-canary";

function fixtureDigest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

test("production Provider composition binds filesystem credentials, Models, loop runtime, and config reload", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-provider-composition-"));
  profiles.push(profilePath);
  await Promise.all([
    mkdir(join(profilePath, "credentials"), { mode: 0o700 }),
    mkdir(join(profilePath, "sessions")),
    mkdir(join(profilePath, "memory")),
    mkdir(join(profilePath, "extensions", "fixture", "skills", "fixture"), {
      recursive: true,
    }),
    mkdir(join(profilePath, ".runtime", "extensions", "fixture"), { recursive: true }),
  ]);
  await chmod(join(profilePath, "credentials"), 0o700);
  await writeFile(join(profilePath, "SOUL.md"), "fixture soul\n");
  const manifestContents = JSON.stringify({
    schemaVersion: 1,
    id: "fixture",
    version: "1.0.0",
    name: "Fixture",
    description: "Proves installed Skills reach the Provider.",
    ziggy: { requires: ">=0.0.0" },
    skills: [{ id: "fixture", path: "skills/fixture" }],
    adapters: [],
    requires: { env: [], commands: [], os: [] },
    permissions: { network: false, filesystem: "none", secrets: [] },
    distribution: { source: "fixture", license: "MIT" },
  });
  const skillContents =
    "---\nname: fixture\ndescription: Fixture Skill\n---\n\nUse the fixture capability.\n";
  await writeFile(join(profilePath, "extensions", "fixture", "extension.json"), manifestContents);
  await writeFile(
    join(profilePath, "extensions", "fixture", "skills", "fixture", "SKILL.md"),
    skillContents,
  );
  const sealedFiles = [
    {
      path: "extension.json",
      kind: "manifest",
      bytes: Buffer.byteLength(manifestContents),
      sha256: fixtureDigest(manifestContents),
    },
    {
      path: "skills/fixture/SKILL.md",
      kind: "skill",
      bytes: Buffer.byteLength(skillContents),
      sha256: fixtureDigest(skillContents),
    },
  ];
  await writeFile(
    join(profilePath, ".runtime", "extensions", "fixture", "state.json"),
    JSON.stringify({ schemaVersion: 1, extensionId: "fixture", enabled: true }),
  );
  await writeFile(
    join(profilePath, ".runtime", "extensions", "fixture", "provenance.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensionId: "fixture",
      extensionVersion: "1.0.0",
      source: { kind: "fixture", locator: "daemon-auth" },
      trustTier: "community",
      verification: { method: "none", keyId: "", signature: "" },
      files: sealedFiles,
      treeDigest: computeTreeDigest(sealedFiles),
    }),
  );
  const runtimeScope = await runEffect(Scope.make());
  const credentials = await runEffect(
    createProfileCredentialStore(profilePath).pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
    ),
  );
  const faux = createFauxCore({
    provider: "fixture-provider",
    models: [{ id: "fixture-model", name: "Fixture Model" }],
  });
  const models = createModels({ credentials });
  models.setProvider(
    createProvider({
      id: "fixture-provider",
      auth: {
        apiKey: {
          name: "Fixture key",
          async login(interaction) {
            return {
              type: "api_key",
              key: await interaction.prompt({ type: "secret", message: "Key" }),
            };
          },
          async check({ credential }) {
            return credential?.type === "api_key" && credential.key !== undefined
              ? { type: "api_key", source: "fixture" }
              : undefined;
          },
          async resolve({ credential }) {
            return credential?.type === "api_key" && credential.key !== undefined
              ? { auth: { apiKey: credential.key }, source: "fixture" }
              : undefined;
          },
        },
      },
      models: faux.models,
      api: { stream: faux.stream, streamSimple: faux.streamSimple },
    }),
  );
  let config: ProviderRuntimeConfig = {
    defaultProvider: "fixture-provider",
    defaultModel: "fixture-model",
    thinkingLevel: "medium",
    cacheRetention: "short",
  };
  const composition = await runEffect(
    createProviderRuntimeComposition({
      profilePath,
      config,
      loadConfig: () => Effect.succeed(config),
      credentials,
      models,
    }).pipe(Effect.provideService(Scope.Scope, runtimeScope)),
  );
  expect(await runEffect(composition.auth.status("fixture-provider"))).toEqual([
    { providerId: "fixture-provider", configured: false },
  ]);
  expect(
    await runEffect(
      composition.auth.login("fixture-provider", "api_key", {
        async prompt() {
          return canary;
        },
        notify() {},
      }),
    ),
  ).toEqual({
    providerId: "fixture-provider",
    configured: true,
    type: "api_key",
    source: "stored",
  });
  faux.setResponses([
    (context) => {
      expect(context.systemPrompt).toContain("fixture soul");
      expect(context.systemPrompt).toContain('<skill id="fixture">');
      expect(context.systemPrompt).toContain("Use the fixture capability.");
      return fauxAssistantMessage("fixture response");
    },
  ]);
  const runtime = await runEffect(
    composition
      .createRuntime("composition-session", createFilesystemWorld({ profilePath }))
      .pipe(Effect.provideService(Scope.Scope, runtimeScope)),
  );
  try {
    await runEffect(runtime.startTurn({ message: "fixture prompt" }));
    await runEffect(runtime.waitForIdle);
    expect(faux.state.callCount).toBe(1);
    expect(
      (
        await readFile(join(profilePath, "sessions", "composition-session.ndjson"), "utf8")
      ).includes(canary),
    ).toBeFalse();
    const incompatibleManifest = manifestContents.replace(
      '"requires":">=0.0.0"',
      '"requires":">9.0.0"',
    );
    const incompatibleFiles = [
      {
        path: "extension.json",
        kind: "manifest",
        bytes: Buffer.byteLength(incompatibleManifest),
        sha256: fixtureDigest(incompatibleManifest),
      },
      {
        path: "skills/fixture/SKILL.md",
        kind: "skill",
        bytes: Buffer.byteLength(skillContents),
        sha256: fixtureDigest(skillContents),
      },
    ];
    await writeFile(
      join(profilePath, "extensions", "fixture", "extension.json"),
      incompatibleManifest,
    );
    await writeFile(
      join(profilePath, ".runtime", "extensions", "fixture", "provenance.json"),
      JSON.stringify({
        schemaVersion: 1,
        extensionId: "fixture",
        extensionVersion: "1.0.0",
        source: { kind: "fixture", locator: "daemon-auth" },
        trustTier: "community",
        verification: { method: "none", keyId: "", signature: "" },
        files: incompatibleFiles,
        treeDigest: computeTreeDigest(incompatibleFiles),
      }),
    );
    await expect(
      runEffect(
        composition
          .createRuntime("incompatible-session", createFilesystemWorld({ profilePath }))
          .pipe(Effect.provideService(Scope.Scope, runtimeScope)),
      ),
    ).rejects.toThrow("Failed to load installed Extension Skills");
    expect(faux.state.callCount).toBe(1);
    config = { ...config, defaultModel: "missing-model" };
    await expect(
      runEffect(
        composition
          .createRuntime("reloaded-session", createFilesystemWorld({ profilePath }))
          .pipe(Effect.provideService(Scope.Scope, runtimeScope)),
      ),
    ).rejects.toThrow("Unknown configured model");
  } finally {
    await runEffect(runtime.close);
    await runEffect(Scope.close(runtimeScope, Exit.void));
  }
});

test("daemon attach auth brokers API-key prompts and returns metadata without echoing credentials", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-daemon-auth-"));
  profiles.push(profilePath);
  let received = "";
  const auth: DaemonAuthService = {
    login(providerId, type, interaction: AuthInteraction) {
      return providerOperation("fixture-login", async () => {
        received = await interaction.prompt({ type: "secret", message: "Enter key" });
        return { providerId, configured: true, type, source: "stored" };
      });
    },
    status(providerId) {
      return Effect.succeed([
        {
          providerId: providerId ?? "anthropic",
          configured: received.length > 0,
          type: "api_key",
          source: "stored",
        },
      ]);
    },
  };
  const server = await runEffect(
    createAttachServer({
      kernel: kernel(profilePath),
      auth,
      nextAuthId: () => "login-1",
      nextAuthPromptId: () => "prompt-1",
    }),
  );
  const peer = await Peer.connect(server.socketPath);
  try {
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "init",
        method: "initialize",
        params: { client: { name: "test", version: "1" }, features: [] },
      }),
    );
    const initialized = await peer.next();
    expect(initialized).toMatchObject({
      type: "success",
      method: "initialize",
      result: { features: expect.arrayContaining(["providerAuth"]) },
    });
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "login",
        method: "auth/login",
        params: { providerId: "anthropic", type: "api_key" },
      }),
    );
    const prompt = await peer.next();
    expect(prompt).toMatchObject({
      type: "auth",
      requestId: "login",
      loginId: "login-1",
      event: { kind: "secret", promptId: "prompt-1", message: "Enter key" },
    });
    expect(JSON.stringify(prompt).includes(canary)).toBeFalse();
    if (prompt.type !== "auth" || !("promptId" in prompt.event)) throw new Error("missing prompt");
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "respond",
        method: "auth/respond",
        params: { loginId: prompt.loginId, promptId: prompt.event.promptId, value: canary },
      }),
    );
    const frames = [await peer.next(), await peer.next()];
    expect(fixtureDigest(received)).toBe(fixtureDigest(canary));
    expect(
      frames.some((frame) => frame.type === "success" && frame.method === "auth/login"),
    ).toBeTrue();
    expect(JSON.stringify(frames).includes(canary)).toBeFalse();
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "status",
        method: "auth/status",
        params: { providerId: "anthropic" },
      }),
    );
    const status = await peer.next();
    expect(status).toMatchObject({
      type: "success",
      method: "auth/status",
      result: {
        providers: [
          { providerId: "anthropic", configured: true, type: "api_key", source: "stored" },
        ],
      },
    });
    expect(JSON.stringify(status).includes(canary)).toBeFalse();
  } finally {
    await peer.close();
    await runEffect(server.close);
  }
});

test("daemon attach auth uses deterministic prompt ids and rejects reuse within a login", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-daemon-auth-prompt-ids-"));
  profiles.push(profilePath);
  const auth: DaemonAuthService = {
    login(providerId, type, interaction) {
      return providerOperation("fixture-login", async () => {
        await interaction.prompt({ type: "text", message: "First" });
        await interaction.prompt({ type: "text", message: "Second" });
        return { providerId, configured: true, type, source: "stored" };
      });
    },
    status: () => Effect.succeed([]),
  };
  const promptIds = ["prompt-1", "prompt-2"];
  const server = await runEffect(
    createAttachServer({
      kernel: kernel(profilePath),
      auth,
      nextAuthId: () => "login-1",
      nextAuthPromptId() {
        const promptId = promptIds.shift();
        if (promptId === undefined) throw new Error("prompt id sequence exhausted");
        return promptId;
      },
    }),
  );
  const peer = await Peer.connect(server.socketPath);
  try {
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "init",
        method: "initialize",
        params: { client: { name: "test", version: "1" }, features: [] },
      }),
    );
    await peer.next();
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "login",
        method: "auth/login",
        params: { providerId: "anthropic", type: "api_key" },
      }),
    );
    for (const expectedPromptId of ["prompt-1", "prompt-2"]) {
      const prompt = await peer.next();
      expect(prompt).toMatchObject({
        type: "auth",
        loginId: "login-1",
        event: { kind: "text", promptId: expectedPromptId },
      });
      if (prompt.type !== "auth" || !("promptId" in prompt.event)) {
        throw new Error("missing deterministic prompt");
      }
      peer.send(
        request({
          schemaVersion: 2,
          requestId: `respond-${expectedPromptId}`,
          method: "auth/respond",
          params: { loginId: prompt.loginId, promptId: prompt.event.promptId, value: "fixture" },
        }),
      );
      expect(await peer.next()).toMatchObject({ type: "success", method: "auth/respond" });
    }
    expect(await peer.next()).toMatchObject({ type: "success", method: "auth/login" });
  } finally {
    await peer.close();
    await runEffect(server.close);
  }

  const duplicateServer = await runEffect(
    createAttachServer({
      kernel: kernel(profilePath),
      auth,
      nextAuthId: () => "login-duplicate",
      nextAuthPromptId: () => "prompt-duplicate",
    }),
  );
  const duplicatePeer = await Peer.connect(duplicateServer.socketPath);
  try {
    duplicatePeer.send(
      request({
        schemaVersion: 2,
        requestId: "init",
        method: "initialize",
        params: { client: { name: "test", version: "1" }, features: [] },
      }),
    );
    await duplicatePeer.next();
    duplicatePeer.send(
      request({
        schemaVersion: 2,
        requestId: "login",
        method: "auth/login",
        params: { providerId: "anthropic", type: "api_key" },
      }),
    );
    const firstPrompt = await duplicatePeer.next();
    if (firstPrompt.type !== "auth" || !("promptId" in firstPrompt.event)) {
      throw new Error("missing duplicate prompt fixture");
    }
    duplicatePeer.send(
      request({
        schemaVersion: 2,
        requestId: "respond",
        method: "auth/respond",
        params: {
          loginId: firstPrompt.loginId,
          promptId: firstPrompt.event.promptId,
          value: "fixture",
        },
      }),
    );
    expect(await duplicatePeer.next()).toMatchObject({ type: "success", method: "auth/respond" });
    expect(await duplicatePeer.next()).toMatchObject({
      type: "error",
      requestId: "login",
      code: "internal",
      message: "Internal daemon error",
    });
  } finally {
    await duplicatePeer.close();
    await runEffect(duplicateServer.close);
  }
});

test("daemon attach auth rejects already-aborted prompts without delivering them", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-daemon-aborted-auth-prompt-"));
  profiles.push(profilePath);
  const auth: DaemonAuthService = {
    login(_providerId, _type, interaction) {
      return providerOperation("fixture-login", async () => {
        const controller = new AbortController();
        controller.abort();
        await interaction.prompt({
          type: "text",
          message: "Cancelled input",
          signal: controller.signal,
        });
        throw new Error("unreachable login continuation");
      });
    },
    status: () => Effect.succeed([]),
  };
  let promptIdCalls = 0;
  const server = await runEffect(
    createAttachServer({
      kernel: kernel(profilePath),
      auth,
      nextAuthId: () => "login-aborted",
      nextAuthPromptId() {
        promptIdCalls += 1;
        return "prompt-aborted";
      },
    }),
  );
  const peer = await Peer.connect(server.socketPath);
  try {
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "init",
        method: "initialize",
        params: { client: { name: "test", version: "1" }, features: [] },
      }),
    );
    await peer.next();
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "login",
        method: "auth/login",
        params: { providerId: "anthropic", type: "api_key" },
      }),
    );
    expect(await peer.next()).toMatchObject({
      type: "error",
      requestId: "login",
      code: "internal",
      message: "Internal daemon error",
    });
    expect(promptIdCalls).toBe(0);
  } finally {
    await peer.close();
    await runEffect(server.close);
  }
});

test("OAuth callback completion cancels a pending Client prompt and completes without input", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-daemon-oauth-callback-"));
  profiles.push(profilePath);
  const promptStarted = Promise.withResolvers<void>();
  const callbackCompleted = Promise.withResolvers<void>();
  const auth: DaemonAuthService = {
    login(providerId, type, interaction) {
      return providerOperation("fixture-oauth", async () => {
        const promptController = new AbortController();
        const prompt = interaction.prompt({
          type: "manual_code",
          message: "Paste callback code",
          signal: promptController.signal,
        });
        promptStarted.resolve();
        await callbackCompleted.promise;
        promptController.abort();
        await prompt.catch(() => undefined);
        return { providerId, configured: true, type, source: "stored" };
      });
    },
    status: () => Effect.succeed([]),
  };
  const server = await runEffect(
    createAttachServer({
      kernel: kernel(profilePath),
      auth,
      nextAuthId: () => "login-callback",
      nextAuthPromptId: () => "prompt-callback",
    }),
  );
  let promptCancelled = false;
  const login = runEffect(
    loginProvider(server.socketPath, "anthropic", "oauth", {
      notify: () => Effect.void,
      prompt(_event, signal) {
        return providerOperation(
          "fixture-client-prompt",
          () =>
            new Promise((_resolve, reject) => {
              const cancel = (): void => {
                promptCancelled = true;
                reject(new Error("cancelled"));
              };
              if (signal.aborted) cancel();
              else signal.addEventListener("abort", cancel, { once: true });
            }),
        );
      },
    }),
  );
  try {
    await promptStarted.promise;
    callbackCompleted.resolve();
    await expect(login).resolves.toEqual({
      providerId: "anthropic",
      configured: true,
      type: "oauth",
      source: "stored",
    });
    expect(promptCancelled).toBeTrue();
  } finally {
    await runEffect(server.close);
  }
});

test("auth Clients reject initialized daemons that do not negotiate Provider auth", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-daemon-no-auth-"));
  profiles.push(profilePath);
  const server = await runEffect(createAttachServer({ kernel: kernel(profilePath) }));
  try {
    await expect(runEffect(queryProviderAuthStatus(server.socketPath))).rejects.toThrow(
      "does not support Provider authentication",
    );
  } finally {
    await runEffect(server.close);
  }
});

test("daemon attach auth maps OAuth notifications and failures without raw Provider errors", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-daemon-oauth-"));
  profiles.push(profilePath);
  const auth: DaemonAuthService = {
    login(_providerId, _type, interaction) {
      interaction.notify({
        type: "auth_url",
        url: "https://example.test/login",
        instructions: "Open browser",
      });
      return Effect.fail(
        new ProviderRuntimeError({
          message: "Fixture OAuth failed",
          cause: `upstream body ${canary}`,
        }),
      );
    },
    status: () => Effect.succeed([]),
  };
  const server = await runEffect(
    createAttachServer({
      kernel: kernel(profilePath),
      auth,
      nextAuthId: () => "login-oauth",
    }),
  );
  const peer = await Peer.connect(server.socketPath);
  try {
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "init",
        method: "initialize",
        params: { client: { name: "test", version: "1" }, features: [] },
      }),
    );
    await peer.next();
    peer.send(
      request({
        schemaVersion: 2,
        requestId: "login",
        method: "auth/login",
        params: { providerId: "openai-codex", type: "oauth" },
      }),
    );
    const notification = await peer.next();
    expect(notification).toMatchObject({
      type: "auth",
      event: { kind: "auth_url", url: "https://example.test/login" },
    });
    const failure = await peer.next();
    expect(failure).toMatchObject({
      type: "error",
      requestId: "login",
      code: "internal",
      message: "Internal daemon error",
    });
    expect(JSON.stringify(failure).includes(canary)).toBeFalse();
  } finally {
    await peer.close();
    await runEffect(server.close);
  }
});

test("terminal malformed attach paths abort and settle pending auth exactly once before peer cleanup", async () => {
  const hostileFrames = [
    Buffer.from([0xff, 0x0a]),
    Buffer.alloc(257, 0x20),
    Buffer.concat([Buffer.alloc(256, 0x20), Buffer.from("\n")]),
  ];
  for (const [index, hostileFrame] of hostileFrames.entries()) {
    const profilePath = await mkdtemp(join(tmpdir(), `ziggy-daemon-terminal-auth-${index}-`));
    profiles.push(profilePath);
    const promptStarted = Promise.withResolvers<void>();
    const loginSettled = Promise.withResolvers<void>();
    let abortCalls = 0;
    const auth: DaemonAuthService = {
      login(_providerId, _type, interaction) {
        return providerOperation("fixture-terminal-auth", async () => {
          interaction.signal?.addEventListener("abort", () => (abortCalls += 1));
          try {
            const prompt = interaction.prompt({ type: "secret", message: "Enter key" });
            promptStarted.resolve();
            await prompt;
            throw new Error("unreachable login continuation");
          } finally {
            loginSettled.resolve();
          }
        });
      },
      status: () => Effect.succeed([]),
    };
    const server = await runEffect(
      createAttachServer({
        kernel: kernel(profilePath),
        auth,
        maxFrameBytes: 256,
        nextAuthId: () => `login-${index}`,
        nextAuthPromptId: () => `prompt-${index}`,
      }),
    );
    const peer = await Peer.connect(server.socketPath, true);
    try {
      peer.send(
        request({
          schemaVersion: 2,
          requestId: "init",
          method: "initialize",
          params: { client: { name: "test", version: "1" }, features: [] },
        }),
      );
      await peer.next();
      peer.send(
        request({
          schemaVersion: 2,
          requestId: "login",
          method: "auth/login",
          params: { providerId: "anthropic", type: "api_key" },
        }),
      );
      await peer.next();
      await promptStarted.promise;
      peer.sendRaw(hostileFrame);
      expect(await peer.next()).toMatchObject({
        type: "error",
        requestId: null,
        code: "malformed-frame",
      });
      await expectSettled(loginSettled.promise, "auth login did not settle after terminal input");
      expect(abortCalls).toBe(1);
    } finally {
      await peer.close();
      await runEffect(server.close);
    }
  }
});

afterAll(async () => {
  emitVerificationObservation("s3.provider-auth", emptyRuntimeObservations());
  await Promise.all(profiles.map((path) => rm(path, { recursive: true, force: true })));
});

function kernel(profilePath: string): DaemonKernel {
  return {
    profilePath,
    createSession: () => Effect.never,
    getOrCreateSession: () => Effect.never,
    ensureMainSession: () => Effect.never,
    getSessionSummary: () => Effect.sync<SessionSummary | undefined>(() => undefined),
    listSessions: Effect.succeed([]),
    close: Effect.void,
  };
}

function providerOperation<A>(
  message: string,
  run: () => PromiseLike<A>,
): Effect.Effect<A, ProviderRuntimeError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new ProviderRuntimeError({ message, cause }),
  });
}

function request(frame: ClientRequestFrame): ClientRequestFrame {
  return frame;
}

class Peer {
  private readonly frames: ServerFrame[] = [];
  private readonly waiters: Array<PromiseWithResolvers<void>> = [];
  private buffer = Buffer.alloc(0);
  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([
        this.buffer,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      while (true) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline < 0) break;
        this.frames.push(decodeServerFrame(this.buffer.subarray(0, newline + 1).toString("utf8")));
        this.buffer = Buffer.from(this.buffer.subarray(newline + 1));
        this.waiters.shift()?.resolve();
      }
    });
  }
  static async connect(path: string, allowHalfOpen = false): Promise<Peer> {
    const socket = createConnection({ path, allowHalfOpen });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new Peer(socket);
  }
  send(frame: ClientRequestFrame): void {
    this.socket.write(encodeClientRequest(frame));
  }
  sendRaw(bytes: Buffer): void {
    this.socket.write(bytes);
  }
  async next(): Promise<ServerFrame> {
    if (this.frames.length === 0) {
      const waiter = Promise.withResolvers<void>();
      this.waiters.push(waiter);
      await waiter.promise;
    }
    const frame = this.frames.shift();
    if (frame === undefined) throw new Error("missing frame");
    return frame;
  }
  close(): Promise<void> {
    this.socket.destroy();
    return Promise.resolve();
  }
}

async function expectSettled(promise: Promise<void>, failure: string): Promise<void> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => timeout.reject(new Error(failure)), 100);
  try {
    await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}
