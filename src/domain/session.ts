import { Schema } from "effect";

export type SessionTerminalState = "completed" | "aborted" | "failed" | "incomplete";

export interface SessionReferenceMetadata {
  readonly id: string;
  readonly path: string;
}

export interface SessionModelChange {
  readonly at: string;
  readonly provider: string;
  readonly model: string;
}

export interface SessionThinkingChange {
  readonly at: string;
  readonly level: string;
}

export interface SessionUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface SessionMetadata {
  readonly path: string;
  readonly id: string;
  readonly kind: "root" | "child";
  readonly createdAt: string;
  readonly entryCount: number;
  readonly parent: SessionReferenceMetadata | undefined;
  readonly parentUnknown: boolean;
  readonly children: ReadonlyArray<SessionReferenceMetadata>;
  readonly modelChanges: ReadonlyArray<SessionModelChange>;
  readonly thinkingChanges: ReadonlyArray<SessionThinkingChange>;
  readonly usage: SessionUsage;
  readonly terminalState: SessionTerminalState;
}

export class SessionReadFailed extends Schema.TaggedErrorClass<SessionReadFailed>()(
  "SessionReadFailed",
  {
    path: Schema.String,
    operation: Schema.Literals(["inspect-root", "walk", "read", "decode", "resolve"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  reference: Schema.String,
  message: Schema.String,
}) {}
