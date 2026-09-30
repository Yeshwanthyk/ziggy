import type {
  AgentSession,
  AgentSessionServices,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Effect } from "effect";
import type { PiResources } from "../extensions";
import type { ChatContext } from "./types";
import type { ProfileAgent } from "../domain/profile";

/** What a module sees when it contributes tools to a Profile session. */
export interface SessionToolContext {
  readonly profilePath: string;
  readonly context: ChatContext;
  readonly agents: ReadonlyArray<ProfileAgent>;
  readonly services: AgentSessionServices;
  readonly resources: PiResources;
  /** The live session; undefined while the runtime is still being built. */
  readonly session: () => AgentSession | undefined;
  /** Show a Profile agent's words to whoever watches this session. */
  readonly voice: (agentId: string, text: string) => void;
}

/**
 * The tool seam: modules such as memory and agents contribute tools here, and the session runtime
 * installs whatever it is given without knowing what they are.
 */
export type SessionTools = (context: SessionToolContext) => ReadonlyArray<ToolDefinition>;

/** What a module sees when it contributes to a Profile session's system prompt. */
export interface SessionPromptContext {
  readonly profilePath: string;
  readonly context: ChatContext;
}

/**
 * The prompt seam: run before every turn, a contribution returns text to append to the system
 * prompt, or nothing. It handles its own failures, so a turn never fails because of it.
 */
export type SessionPrompt = (context: SessionPromptContext) => Effect.Effect<string | undefined>;
