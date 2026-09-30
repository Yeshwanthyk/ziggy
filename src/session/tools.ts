import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Effect } from "effect";
import type { ZiggyAgentError } from "../domain/agent";
import type { ChatContext } from "./types";

/** What a module sees when it contributes tools to a Profile session. */
export interface SessionToolContext {
  readonly profilePath: string;
  readonly context: ChatContext;
  /** The live session; undefined while the runtime is still being built. */
  readonly session: () => AgentSession | undefined;
  /** Show a Profile agent's words to whoever watches this session. */
  readonly voice: (agentId: string, text: string) => void;
}

/**
 * The tool seam: modules such as memory and agents contribute tools here, once per runtime, and
 * the session runtime installs whatever it is given without knowing what they are.
 */
export type SessionTools = (
  context: SessionToolContext,
) => Effect.Effect<ReadonlyArray<ToolDefinition>, ZiggyAgentError>;

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

/** The input seam: rewrites or refuses what the user typed before a Profile session sees it. */
export type SessionPrepare = (
  profilePath: string,
  text: string,
) => Effect.Effect<string, ZiggyAgentError>;
