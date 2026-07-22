import type {
  ApprovalDecision,
  ApprovalResolveRequest,
  SessionEnvelope,
  SessionSummary,
  TurnInterruptRequest,
  TurnStartRequest,
  TurnSteerRequest,
} from "@ziggy/protocol";

export type ConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "replaying"; readonly throughSeq: number }
  | { readonly kind: "live" }
  | { readonly kind: "disconnected"; readonly message: string }
  | { readonly kind: "retrying"; readonly attempt: number }
  | { readonly kind: "outcome-unknown"; readonly message: string };

export type TurnState =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly turnId: string; readonly model?: string };

export type TranscriptItem =
  | {
      readonly kind: "user";
      readonly turnId: string;
      readonly mode: "message" | "follow-up" | "steer";
      readonly text: string;
    }
  | {
      readonly kind: "assistant";
      readonly turnId: string;
      readonly stepId: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "activity";
      readonly turnId: string;
      readonly text: string;
      readonly tone: "normal" | "error";
    };

export interface ApprovalOverlay {
  readonly kind: "approval";
  readonly approvalId: string;
  readonly prompt: string;
  readonly choices: ReadonlyArray<ApprovalDecision>;
  readonly selected: ApprovalDecision;
}

export interface SessionPickerOverlay {
  readonly kind: "sessions";
  readonly selectedIndex: number;
}

export type OverlayState = { readonly kind: "none" } | ApprovalOverlay | SessionPickerOverlay;

export interface SessionProjection {
  readonly summary: SessionSummary;
  readonly lastAppliedSeq: number;
  readonly pendingEnvelopes: ReadonlyArray<SessionEnvelope>;
  readonly transcript: ReadonlyArray<TranscriptItem>;
  readonly turn: TurnState;
  readonly pendingApproval: ApprovalOverlay | null;
}

export type DisplayedSession =
  | { readonly kind: "empty" }
  | { readonly kind: "loaded"; readonly projection: SessionProjection };

export interface TuiState {
  readonly connection: ConnectionState;
  readonly displayed: DisplayedSession;
  readonly sessions: ReadonlyArray<SessionSummary>;
  readonly composer: string;
  readonly overlay: OverlayState;
  readonly resumeGeneration: number;
  readonly error: string | null;
}

export type TuiIntent =
  | "enter"
  | "follow-up"
  | "interrupt"
  | "sessions"
  | "dismiss"
  | "move-up"
  | "move-down"
  | "approve"
  | "deny"
  | "detach";

export type TuiAction =
  | { readonly type: "main-ensured"; readonly session: SessionSummary }
  | { readonly type: "sessions-listed"; readonly sessions: ReadonlyArray<SessionSummary> }
  | {
      readonly type: "replay-started";
      readonly generation: number;
      readonly session: SessionSummary;
      readonly replayThroughSeq: number;
    }
  | {
      readonly type: "envelope-received";
      readonly generation: number;
      readonly envelope: SessionEnvelope;
    }
  | { readonly type: "composer-changed"; readonly value: string }
  | { readonly type: "command-admitted"; readonly command: TuiCommand }
  | { readonly type: "intent"; readonly intent: TuiIntent }
  | {
      readonly type: "connection-lost";
      readonly generation: number;
      readonly message: string;
    }
  | { readonly type: "retry-started"; readonly generation: number; readonly attempt: number }
  | {
      readonly type: "outcome-unknown";
      readonly generation: number;
      readonly message: string;
      readonly composer: string;
    }
  | { readonly type: "failure"; readonly generation?: number; readonly message: string }
  | { readonly type: "clear-error" };

export type TuiCommand =
  | { readonly type: "ensure-main" }
  | { readonly type: "list-sessions" }
  | {
      readonly type: "resume-session";
      readonly generation: number;
      readonly sessionId: string;
      readonly sinceSeq: number;
    }
  | {
      readonly type: "start-turn";
      readonly generation: number;
      readonly request: TurnStartRequest;
    }
  | {
      readonly type: "steer-turn";
      readonly generation: number;
      readonly request: TurnSteerRequest;
    }
  | {
      readonly type: "queue-follow-up";
      readonly generation: number;
      readonly request: TurnStartRequest;
    }
  | {
      readonly type: "interrupt-turn";
      readonly generation: number;
      readonly request: TurnInterruptRequest;
    }
  | {
      readonly type: "resolve-approval";
      readonly generation: number;
      readonly request: ApprovalResolveRequest;
    }
  | { readonly type: "detach" };

export interface TuiTransition {
  readonly state: TuiState;
  readonly commands: ReadonlyArray<TuiCommand>;
}

export function createInitialState(): TuiState {
  return {
    connection: { kind: "connecting" },
    displayed: { kind: "empty" },
    sessions: [],
    composer: "",
    overlay: { kind: "none" },
    resumeGeneration: 0,
    error: null,
  };
}

export function initialCommands(): ReadonlyArray<TuiCommand> {
  return [{ type: "ensure-main" }];
}
