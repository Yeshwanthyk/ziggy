import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createPiDocsExtension } from "./pi-docs";
import { createZiggyHelpExtension } from "./ziggy-help";
import { createSessionNamingExtension } from "./session-name";

/** Appends what modules contributed through the session prompt seam, reread every turn. */
export const createContributedPromptExtension = (
  contributed: () => Promise<ReadonlyArray<string>>,
): InlineExtension => ({
  name: "ziggy-contributed-prompt",
  hidden: true,
  factory: (pi) => {
    pi.on("before_agent_start", (event) =>
      contributed().then((parts) =>
        parts.length === 0
          ? undefined
          : { systemPrompt: [event.systemPrompt, ...parts].join("\n\n") },
      ),
    );
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
  readonly contributedPrompt: () => Promise<ReadonlyArray<string>>;
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
  contributedPrompt,
  ephemeralPromptContext,
}) => [
  createPiDocsExtension(),
  createZiggyHelpExtension(),
  createSessionNamingExtension(),
  createContributedPromptExtension(contributedPrompt),
  createEphemeralPromptContextExtension(ephemeralPromptContext),
];

/** A Profile agent's session: only the read-only Ziggy reference tools, no Profile prompt seams. */
export const createPersonaInlineExtensions = (): ReadonlyArray<InlineExtension> => [
  createPiDocsExtension(),
  createZiggyHelpExtension(),
];
