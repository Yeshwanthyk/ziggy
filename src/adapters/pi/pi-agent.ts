import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  InteractiveMode,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
  runPrintMode,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { Type } from "typebox";
import {
  ProfileNotInitialized,
  ProviderCallError,
  ProviderConfigError,
  type ZiggyAgentError,
} from "../../domain/agent";
import {
  codePointLength,
  memoryFilePaths,
  type ChatContext,
  type MemoryDocument,
  type MemoryScope,
} from "../../domain/memory";
import type { ProfileTarget } from "../../domain/profile";

export interface PiAgentShape {
  readonly askOnce: (
    target: ProfileTarget,
    prompt: string,
    continueSession: boolean,
    context: ChatContext,
  ) => Effect.Effect<number, ZiggyAgentError>;
  readonly openTui: (
    target: ProfileTarget,
    context: ChatContext,
  ) => Effect.Effect<number, ZiggyAgentError>;
}

export class PiAgent extends Context.Service<PiAgent, PiAgentShape>()("ziggy/PiAgent") {}

const causeMessage = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").trim();

const isProviderConfigFailure = (cause: unknown): boolean => {
  const message = causeMessage(cause).toLowerCase();
  return [
    "no model",
    "no api key",
    "no authentication method",
    "provider is not configured",
    "auth.json",
    "models.json",
    "settings.json",
    "credential",
    "authentication failed",
  ].some((fragment) => message.includes(fragment));
};

const providerError = (
  profilePath: string,
  operation: string,
  cause: unknown,
): ProviderConfigError | ProviderCallError => {
  if (cause instanceof ProviderConfigError || cause instanceof ProviderCallError) {
    return cause;
  }

  if (operation !== "call provider" || isProviderConfigFailure(cause)) {
    return new ProviderConfigError({
      profilePath,
      operation,
      message: `provider configuration failed; place credentials in ${join(profilePath, "auth.json")} and model configuration in ${join(profilePath, "models.json")}`,
      cause,
    });
  }

  return new ProviderCallError({
    profilePath,
    operation,
    message: `provider request failed: ${causeMessage(cause)}`,
    cause,
  });
};

const piPromise = <A>(
  profilePath: string,
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, ProviderConfigError | ProviderCallError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => providerError(profilePath, operation, cause),
  });

const requireSoul = (profilePath: string) => {
  const soulPath = join(profilePath, "SOUL.md");
  return Effect.tryPromise({
    try: () => stat(soulPath),
    catch: (cause) => {
      const code =
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
      return code === "ENOENT"
        ? new ProfileNotInitialized({
            profilePath,
            message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
          })
        : new ProviderConfigError({
            profilePath,
            operation: "read system prompt",
            message: `could not read ${soulPath}`,
            cause,
          });
    },
  }).pipe(
    Effect.flatMap((status) =>
      status.isFile()
        ? Effect.succeed(soulPath)
        : Effect.fail(
            new ProfileNotInitialized({
              profilePath,
              message: `profile is not initialized at ${profilePath}; run 'ziggy init <name|path>'`,
            }),
          ),
    ),
  );
};

const memoryWriteParameters = Type.Object({
  scope: Type.Union([Type.Literal("shared"), Type.Literal("person"), Type.Literal("group")]),
  content: Type.String(),
});

const toolResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

const toolError = (message: string) => toolResult(`ERROR: ${message}`);

const atomicReplace = async (
  document: MemoryDocument,
  content: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly cause: unknown }> => {
  const temporaryPath = join(dirname(document.absolutePath), `.${randomUUID()}.memory-write.tmp`);

  return mkdir(dirname(document.absolutePath), { recursive: true })
    .then(() => writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" }))
    .then(() => rename(temporaryPath, document.absolutePath))
    .then(
      () => ({ ok: true as const }),
      async (cause: unknown) => {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        return { ok: false as const, cause };
      },
    );
};

const writableMemoryDocument = (
  profilePath: string,
  context: ChatContext,
  scope: MemoryScope,
):
  | { readonly ok: true; readonly document: MemoryDocument }
  | { readonly ok: false; readonly message: string } => {
  const paths = memoryFilePaths(profilePath, context);
  if (!paths.ok) {
    return { ok: false, message: paths.error.message };
  }

  if (scope === "person" && context.kind === "group") {
    return { ok: false, message: "person memory is not writable in group chats" };
  }

  if (scope === "group" && context.kind !== "group") {
    return { ok: false, message: "group memory is not writable in 1:1 chats" };
  }

  const document = paths.documents.find((candidate) => candidate.scope === scope);
  if (document === undefined) {
    return { ok: false, message: `${scope} memory is not available in this chat` };
  }

  return { ok: true, document };
};

export const createMemoryWriteTool = (
  profilePath: string,
  context: ChatContext,
): ToolDefinition<typeof memoryWriteParameters> => ({
  name: "memory_write",
  label: "memory_write",
  description:
    "Atomically replace a curated memory document. Use shared for assistant-wide facts (2200 code points), person for the current 1:1 person (1375), or group for the current group (1375). Person memory is unavailable in groups; group memory is unavailable in 1:1 chats.",
  parameters: memoryWriteParameters,
  async execute(_toolCallId, { scope, content }) {
    const target = writableMemoryDocument(profilePath, context, scope);
    if (!target.ok) {
      return toolError(target.message);
    }

    const length = codePointLength(content);
    if (length > target.document.cap) {
      return toolError(
        `memory full: ${length}/${target.document.cap} code points — trim and retry`,
      );
    }

    const write = await atomicReplace(target.document, content);
    if (!write.ok) {
      return toolError(`memory write failed: ${causeMessage(write.cause)}`);
    }

    return toolResult(
      `saved ${length}/${target.document.cap} code points to ${target.document.relativePath}`,
    );
  },
});

const readMemoryDocument = (
  document: MemoryDocument,
): Promise<
  | { readonly ok: true; readonly content: string | undefined }
  | { readonly ok: false; readonly cause: unknown }
> =>
  readFile(document.absolutePath, "utf8").then(
    (content) => ({ ok: true, content: content.trim().length === 0 ? undefined : content }),
    (cause: unknown) => {
      const code =
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined;
      return code === "ENOENT" ? { ok: true, content: undefined } : { ok: false, cause };
    },
  );

const buildMemoryPrompt = async (
  profilePath: string,
  documents: ReadonlyArray<MemoryDocument>,
): Promise<string> => {
  const loaded = await Promise.all(documents.map(readMemoryDocument));
  const sections: Array<string> = [];

  for (const [index, result] of loaded.entries()) {
    if (!result.ok) {
      const document = documents[index];
      throw new ProviderConfigError({
        profilePath,
        operation: "read memory",
        message: `could not read ${document?.absolutePath ?? profilePath}`,
        cause: result.cause,
      });
    }

    const document = documents[index];
    if (result.content !== undefined && document !== undefined) {
      sections.push(`${document.heading}\n${result.content}`);
    }
  }

  sections.push(
    "Durable facts should be saved with the memory_write tool. Memory is capped, so keep it curated.",
  );
  return sections.join("\n\n");
};

export const askOnce = (
  target: ProfileTarget,
  prompt: string,
  continueSession: boolean,
  context: ChatContext,
): Effect.Effect<number, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const sessionDirectory = join(target.path, "sessions");
    const sessionManager = continueSession
      ? SessionManager.continueRecent(target.path, sessionDirectory)
      : SessionManager.create(target.path, sessionDirectory);
    const runtime = yield* createProfileRuntime(
      target.path,
      soulPath,
      sessionManager,
      context,
      "memory-only",
    );

    if (runtime.modelFallbackMessage !== undefined) {
      return yield* new ProviderConfigError({
        profilePath: target.path,
        operation: "select model",
        message: `no configured model is available; place credentials in ${join(target.path, "auth.json")} and model configuration in ${join(target.path, "models.json")}`,
        cause: new Error(runtime.modelFallbackMessage),
      });
    }

    let printError: string | undefined;
    const originalConsoleError = console.error;
    console.error = (...values: ReadonlyArray<unknown>) => {
      printError = values.map(String).join(" ");
    };

    const exitCode = yield* piPromise(target.path, "call provider", () =>
      runPrintMode(runtime, {
        mode: "text",
        initialMessage: prompt,
      }).finally(() => {
        console.error = originalConsoleError;
      }),
    );

    if (exitCode !== 0) {
      return yield* providerError(
        target.path,
        "call provider",
        new Error(printError ?? `provider returned exit code ${exitCode}`),
      );
    }

    return exitCode;
  });

const createProfileRuntime = (
  profilePath: string,
  soulPath: string,
  sessionManager: SessionManager,
  context: ChatContext,
  toolMode: "default" | "memory-only",
) => {
  const paths = memoryFilePaths(profilePath, context);
  if (!paths.ok) {
    return Effect.fail(paths.error);
  }

  return piPromise(profilePath, "create agent runtime", () =>
    createAgentSessionRuntime(
      async ({ cwd, agentDir, sessionManager: runtimeSessionManager, sessionStartEvent }) => {
        const memoryPrompt = await buildMemoryPrompt(profilePath, paths.documents);
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          resourceLoaderOptions: {
            systemPrompt: soulPath,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            appendSystemPrompt: [memoryPrompt],
          },
        });
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: runtimeSessionManager,
          ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
          customTools: [createMemoryWriteTool(profilePath, context)],
          ...(toolMode === "memory-only" ? { tools: ["memory_write"] } : {}),
        });
        return {
          ...created,
          services,
          diagnostics: services.diagnostics,
        };
      },
      {
        cwd: profilePath,
        agentDir: profilePath,
        sessionManager,
      },
    ),
  );
};

export const openTui = (
  target: ProfileTarget,
  context: ChatContext,
): Effect.Effect<number, ZiggyAgentError> =>
  Effect.gen(function* () {
    const soulPath = yield* requireSoul(target.path);
    const sessionManager = SessionManager.create(target.path, join(target.path, "sessions"));
    const runtime = yield* createProfileRuntime(
      target.path,
      soulPath,
      sessionManager,
      context,
      "default",
    );

    yield* piPromise(target.path, "open interactive mode", async () => {
      initTheme();
      const interactiveMode = new InteractiveMode(runtime, {});
      await interactiveMode.run();
    });

    return 0;
  });

export const PiAgentLive = Layer.succeed(PiAgent, { askOnce, openTui });
