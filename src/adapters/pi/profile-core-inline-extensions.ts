import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { ProviderConfigError } from "../../domain/agent";
import type { ProfileAgent } from "../../domain/profile";
import { renderMemoryForPrompt, type MemoryDocument } from "../../domain/memory";
import { fileSystemCauseDetails } from "../fs/cause";
import type { AutomationTuiDispatch } from "./automation-tui";
import type { ProfileExtensionSelectionRunner } from "./profile-extension-selection";
import {
  createProfileAgentGuidanceExtension,
  createZiggyTuiExtension,
} from "./ziggy-tui-extension";

interface LoadedMemoryDocument {
  readonly content: string;
}

const causeMessage = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/gu, " ").trim();

const inspectMemoryFile = async (
  document: MemoryDocument,
): Promise<LoadedMemoryDocument | undefined> => {
  try {
    const status = await lstat(document.absolutePath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`${document.absolutePath} must be a regular non-symlink memory file`);
    }
    const file = await open(document.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return { content: (await file.readFile()).toString("utf8") };
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (fileSystemCauseDetails(cause).code === "ENOENT") return undefined;
    throw cause;
  }
};

const readMemoryDocument = (
  document: MemoryDocument,
): Effect.Effect<LoadedMemoryDocument | undefined, unknown> =>
  Effect.tryPromise({
    try: () => inspectMemoryFile(document),
    catch: (cause) => cause,
  });

const buildMemoryPrompt = (
  profilePath: string,
  documents: ReadonlyArray<MemoryDocument>,
): Effect.Effect<string, ProviderConfigError> =>
  Effect.forEach(documents, (document) =>
    readMemoryDocument(document).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderConfigError({
            profilePath,
            operation: "read memory",
            message: `could not read ${document.absolutePath}`,
            cause,
          }),
      ),
      Effect.map((loaded) => ({
        document,
        content:
          loaded === undefined || loaded.content.trim().length === 0 ? undefined : loaded.content,
      })),
    ),
  ).pipe(
    Effect.map((loaded) => {
      const sections = loaded.flatMap(({ document, content }) =>
        content === undefined ? [] : [`${document.heading}\n${renderMemoryForPrompt(content)}`],
      );
      sections.push(
        "Durable facts should be saved with the memory_write tool. Memory is capped, so keep it curated.",
      );
      return sections.join("\n\n");
    }),
  );

const memoryReadFailurePrompt = (profilePath: string, cause: unknown): string =>
  [
    "PROFILE MEMORY UNAVAILABLE FOR THIS TURN.",
    `Ziggy could not read the admitted Profile memory under ${profilePath}: ${causeMessage(cause)}`,
    "Do not claim to remember Profile facts or call memory_write this turn. Tell the user that Profile memory is unavailable.",
  ].join("\n");

/** Refresh the admitted Profile memory without creating a session or provider request. */
export const refreshProfileMemory = (
  profilePath: string,
  documents: ReadonlyArray<MemoryDocument>,
  event: Pick<BeforeAgentStartEvent, "systemPrompt">,
): Promise<BeforeAgentStartEventResult> => {
  const program = buildMemoryPrompt(profilePath, documents).pipe(
    Effect.match({
      onFailure: (cause) => ({
        systemPrompt: `${event.systemPrompt}\n\n${memoryReadFailurePrompt(profilePath, cause)}`,
      }),
      onSuccess: (memoryPrompt) => ({
        systemPrompt: `${event.systemPrompt}\n\n${memoryPrompt}`,
      }),
    }),
  );
  // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning before_agent_start callback; this is the single adapter bridge.
  return Effect.runPromise(program);
};

export const createProfileMemoryExtension = (
  profilePath: string,
  documents: ReadonlyArray<MemoryDocument>,
): InlineExtension => ({
  name: "ziggy-profile-memory",
  hidden: true,
  factory: (pi) => {
    pi.on("before_agent_start", (event) => refreshProfileMemory(profilePath, documents, event));
  },
});

export const appendEphemeralPromptContext = (
  event: Pick<BeforeAgentStartEvent, "systemPrompt">,
  context: string,
): BeforeAgentStartEventResult => ({
  systemPrompt: `${event.systemPrompt}\n\n${context}`,
});

export const createEphemeralPromptContextExtension = (
  current: () => string | undefined,
): InlineExtension => ({
  name: "ziggy-ephemeral-prompt-context",
  hidden: true,
  factory: (pi) => {
    pi.on("before_agent_start", (event) => {
      const context = current();
      return context === undefined ? undefined : appendEphemeralPromptContext(event, context);
    });
  },
});

export interface ProfileCoreInlineExtensionOptions {
  readonly profilePath: string;
  readonly agents: ReadonlyArray<ProfileAgent>;
  readonly memoryDocuments: ReadonlyArray<MemoryDocument>;
  readonly extensionSelection?: ProfileExtensionSelectionRunner | undefined;
  readonly automationDispatch?: AutomationTuiDispatch | undefined;
  readonly ephemeralPromptContext: () => string | undefined;
}

/**
 * The inline extensions that are part of Ziggy's production Pi composition.
 *
 * Keep this factory free of the pi-agent module so both runtime construction and
 * disposable preflight can use it without creating an adapter cycle. The join
 * may pass its production factory to makeProfileExtensionPreflight when it has
 * additional runtime-specific implementations to preserve.
 */
export type ProfileCoreInlineExtensionFactory = (
  options: ProfileCoreInlineExtensionOptions,
) => ReadonlyArray<InlineExtension>;

export const createProfileCoreInlineExtensions: ProfileCoreInlineExtensionFactory = ({
  profilePath,
  agents,
  memoryDocuments,
  extensionSelection,
  automationDispatch,
  ephemeralPromptContext,
}) => [
  createZiggyTuiExtension(profilePath, agents, extensionSelection, automationDispatch),
  ...(agents.length === 0 ? [] : [createProfileAgentGuidanceExtension(agents)]),
  createProfileMemoryExtension(profilePath, memoryDocuments),
  createEphemeralPromptContextExtension(ephemeralPromptContext),
];
