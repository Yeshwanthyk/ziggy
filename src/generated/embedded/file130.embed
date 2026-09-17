/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Invalid observed tool inputs are withheld instead of entering durable state. */
/* oxlint-disable ziggy/no-conditional-empty-object-spread -- Exact optional properties are assembled from schema-decoded optional inputs. */
/* oxlint-disable ziggy/no-unsafe-dictionary-type -- Pi's public custom-tool event contract supplies Record<string, unknown>; every supported input is immediately schema-decoded. */
/* oxlint-disable ziggy/no-runtime-typeof -- Tool-result details are an untrusted event boundary probed only to fail wait evidence closed. */
/* oxlint-disable ziggy/require-readable-spacing -- Sanitization branches keep decode and projection together. */
import { Parse } from "typebox/value";
import { Type, type Static } from "typebox";
import { normalizeSafeControlKeypress } from "./execution-plan.ts";
import {
  SafeKeypressKeysSchema,
  type RecordedCall,
  type RecordedInput,
  type WorkflowDraft,
} from "./schema.ts";

const COMPUTER_USE_TOOLS = new Set([
  "find_roots",
  "observe_ui",
  "search_ui",
  "expand_ui",
  "inspect_ui",
  "act_ui",
  "read_text",
  "wait_for",
  "launch_browser",
  "navigate_browser",
  "evaluate_browser",
  "close_browser",
  "run_ui_segment",
]);

const Ref = Type.String({ pattern: "^@[ero][A-Za-z0-9._:-]*$" });

const StateId = Type.String({ minLength: 1, maxLength: 256 });

const FindInput = Type.Object(
  {
    text: Type.Optional(Type.String({ maxLength: 256 })),
    app: Type.Optional(Type.String({ maxLength: 256 })),
    bundleId: Type.Optional(Type.String({ maxLength: 256 })),
    pid: Type.Optional(Type.Number()),
    kind: Type.Optional(
      Type.Union([
        Type.Literal("window"),
        Type.Literal("menu"),
        Type.Literal("sheet"),
        Type.Literal("popover"),
        Type.Literal("dialog"),
        Type.Literal("browser_page"),
      ]),
    ),
  },
  { additionalProperties: false },
);

const ObserveInput = Type.Object(
  {
    root: Type.Optional(Ref),
    mode: Type.Optional(
      Type.Union([Type.Literal("semantic"), Type.Literal("visual"), Type.Literal("fused")]),
    ),
  },
  { additionalProperties: false },
);

const SearchInput = Type.Object(
  {
    text: Type.Optional(Type.String({ maxLength: 256 })),
    role: Type.Optional(Type.String({ maxLength: 128 })),
    capability: Type.Optional(Type.String({ maxLength: 128 })),
    stateId: StateId,
  },
  { additionalProperties: false },
);

const Condition = {
  ref: Type.Optional(Ref),
  scopeRef: Type.Optional(Ref),
  text: Type.Optional(Type.String({ maxLength: 512 })),
  role: Type.Optional(Type.String({ maxLength: 128 })),
  value: Type.Optional(Type.String()),
  until: Type.Optional(Type.Union([Type.Literal("present"), Type.Literal("absent")])),
  timeoutMs: Type.Optional(Type.Number({ minimum: 100, maximum: 60_000 })),
};

const Point = { x: Type.Number(), y: Type.Number() };

const Action = Type.Union([
  Type.Object({ action: Type.Literal("press"), ref: Ref }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("click"),
      ref: Ref,
      button: Type.Optional(Type.String()),
      clickCount: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("click"),
      ...Point,
      button: Type.Optional(Type.String()),
      clickCount: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("setText"), ref: Ref, text: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("typeText"), ref: Type.Optional(Ref), text: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("keypress"),
      ref: Type.Optional(Ref),
      keys: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("scroll"),
      ref: Type.Optional(Ref),
      scrollX: Type.Optional(Type.Number()),
      scrollY: Type.Optional(Type.Number()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("drag"),
      path: Type.Array(Type.Object(Point, { additionalProperties: false }), { minItems: 2 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("moveMouse"), ...Point }, { additionalProperties: false }),
]);

const ActInput = Type.Object(
  {
    stateId: StateId,
    expect: Type.Optional(Type.Object(Condition, { additionalProperties: false })),
    actions: Type.Array(Action, { minItems: 1, maxItems: 20 }),
  },
  { additionalProperties: false },
);

const WaitInput = Type.Object({ ...Condition, stateId: StateId }, { additionalProperties: false });

const BrowserInput = Type.Object(
  {
    url: Type.Optional(Type.String({ maxLength: 8_192 })),
    stateId: Type.Optional(StateId),
    profile: Type.Optional(Type.String({ maxLength: 64 })),
    mode: Type.Optional(Type.Union([Type.Literal("foreground"), Type.Literal("background")])),
  },
  { additionalProperties: false },
);

const RecordedCondition = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    until: Type.Union([Type.Literal("present"), Type.Literal("absent")]),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
  },
  { additionalProperties: false },
);

const SegmentInput = Type.Object(
  {
    rootQuery: Type.Optional(
      Type.Object(
        {
          text: Type.Optional(Type.String({ maxLength: 256 })),
          app: Type.Optional(Type.String({ maxLength: 256 })),
          bundleId: Type.Optional(Type.String({ maxLength: 256 })),
          kind: Type.Optional(
            Type.Union([
              Type.Literal("window"),
              Type.Literal("menu"),
              Type.Literal("sheet"),
              Type.Literal("popover"),
              Type.Literal("dialog"),
              Type.Literal("browser_page"),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    steps: Type.Array(
      Type.Union([
        Type.Object({ assert: RecordedCondition }, { additionalProperties: false }),
        Type.Object(
          {
            target: Type.Object(
              {
                text: Type.Optional(Type.String({ maxLength: 256 })),
                role: Type.Optional(Type.String({ maxLength: 128 })),
                capability: Type.Optional(Type.String({ maxLength: 128 })),
              },
              { additionalProperties: false },
            ),
            actions: Type.Array(
              Type.Union([
                Type.Object(
                  {
                    action: Type.Literal("click"),
                    button: Type.Optional(
                      Type.Union([
                        Type.Literal("left"),
                        Type.Literal("right"),
                        Type.Literal("middle"),
                      ]),
                    ),
                    clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
                  },
                  { additionalProperties: false },
                ),
                Type.Object(
                  { action: Type.Literal("keypress"), keys: SafeKeypressKeysSchema },
                  { additionalProperties: false },
                ),
                Type.Object(
                  {
                    action: Type.Literal("scroll"),
                    scrollX: Type.Optional(Type.Number()),
                    scrollY: Type.Optional(Type.Number()),
                  },
                  { additionalProperties: false },
                ),
              ]),
              { minItems: 1, maxItems: 20 },
            ),
            expect: RecordedCondition,
          },
          { additionalProperties: false },
        ),
      ]),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

const SegmentResult = Type.Object(
  {
    tool: Type.Literal("run_ui_segment"),
    status: Type.Literal("completed"),
    completed: Type.Array(
      Type.Object(
        {
          step: Type.Integer({ minimum: 1, maximum: 20 }),
          stateId: Type.String({ minLength: 1 }),
          ref: Type.Optional(Type.String({ minLength: 1 })),
          kind: Type.Optional(Type.Literal("assert")),
          actionCount: Type.Integer({ minimum: 0, maximum: 20 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

const ActResult = Type.Object(
  {
    tool: Type.Literal("act_ui"),
    execution: Type.Object(
      {
        verification: Type.Object(
          { status: Type.Union([Type.Literal("verified"), Type.Literal("preexisting")]) },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

type PendingCall = {
  readonly sequence: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly input: RecordedInput;
  readonly issues: string[];
};

export type ActiveRecording = {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly pending: Map<string, PendingCall>;
  readonly completed: RecordedCall[];
  nextSequence: number;
};

const withoutTransientText = (value: string | undefined): string | undefined =>
  value === undefined || /@[ero][A-Za-z0-9._:-]*/.test(value) ? undefined : value;

const withheld = (reason: "transient-reference" | "arbitrary-code" | "unsupported-input") =>
  ({ kind: "withheld", reason }) as const;

type SanitizedInput = { readonly input: RecordedInput; readonly issues: string[] };

const sanitizeActions = (
  actions: Static<typeof ActInput>["actions"],
  sequence: number,
): SanitizedInput => {
  const safeActions: Static<typeof Action>[] = actions;
  const sanitized: Extract<RecordedInput, { kind: "safe_actions" }>["actions"] = [];
  const issues: string[] = [];
  let variableIndex = 0;

  for (const action of safeActions) {
    if (action.action === "setText" || action.action === "typeText") {
      variableIndex += 1;
      sanitized.push({
        action: "variable-input",
        variable: `input-${sequence}-${variableIndex}`,
        target: action.ref === undefined ? "focused" : "requires-review",
      });
      issues.push(
        "Typed text was not recorded; define and bind the generated variable during review.",
      );
    } else if (action.action === "keypress") {
      const normalized = normalizeSafeControlKeypress(action.keys);

      if (normalized === undefined) {
        sanitized.push({ action: "requires-review", reason: "unsupported-action" });
        issues.push(
          "A text-producing keypress was withheld; only control/navigation keys and explicit modifier chords are recordable.",
        );
      } else {
        sanitized.push({
          action: "keypress",
          keys: Parse(SafeKeypressKeysSchema, normalized),
          target: action.ref === undefined ? "focused" : "requires-review",
        });
      }
    } else if (action.action === "scroll") {
      sanitized.push({
        action: "scroll",
        ...(action.scrollX === undefined ? {} : { scrollX: action.scrollX }),
        ...(action.scrollY === undefined ? {} : { scrollY: action.scrollY }),
        target: action.ref === undefined ? "root" : "requires-review",
      });

      if (action.ref !== undefined) issues.push("Replace the transient scroll ref with a target.");
    } else if (action.action === "press" || (action.action === "click" && "ref" in action)) {
      sanitized.push({ action: "requires-review", reason: "transient-target" });
      issues.push("Replace the transient UI ref with a semantic target.");
    } else if (
      action.action === "click" ||
      action.action === "drag" ||
      action.action === "moveMouse"
    ) {
      sanitized.push({ action: "requires-review", reason: "coordinate-action" });
      issues.push(
        "Coordinate actions are not publishable; replace this action with a semantic target.",
      );
    }
  }

  return {
    input: {
      kind: "safe_actions",
      actions: sanitized,
      ...(actions.length > 0 ? {} : {}),
    },
    issues,
  };
};

const sanitizeComputerUseInput = (
  toolName: string,
  input: Record<string, unknown>,
  sequence: number,
): SanitizedInput => {
  try {
    if (toolName === "find_roots") {
      const decoded = Parse(FindInput, input);

      return {
        input: {
          kind: "find_roots",
          ...(withoutTransientText(decoded.text) === undefined ? {} : { text: decoded.text }),
          ...(withoutTransientText(decoded.app) === undefined ? {} : { app: decoded.app }),
          ...(withoutTransientText(decoded.bundleId) === undefined
            ? {}
            : { bundleId: decoded.bundleId }),
          ...(decoded.kind === undefined ? {} : { rootKind: decoded.kind }),
        },
        issues:
          decoded.pid === undefined
            ? []
            : ["Process ids are session-specific and were not recorded."],
      };
    }

    if (toolName === "observe_ui") {
      const decoded = Parse(ObserveInput, input);

      return {
        input: {
          kind: "observe_ui",
          ...(decoded.mode === undefined ? {} : { mode: decoded.mode }),
        },
        issues: decoded.root === undefined ? [] : ["The transient root ref was not recorded."],
      };
    }

    if (toolName === "search_ui") {
      const decoded = Parse(SearchInput, input);

      return {
        input: {
          kind: "search_ui",
          ...(withoutTransientText(decoded.text) === undefined ? {} : { text: decoded.text }),
          ...(decoded.role === undefined ? {} : { role: decoded.role }),
          ...(decoded.capability === undefined ? {} : { capability: decoded.capability }),
        },
        issues: [],
      };
    }

    if (toolName === "act_ui") {
      const decoded = Parse(ActInput, input);
      const sanitized = sanitizeActions(decoded.actions, sequence);
      return {
        ...sanitized,
        input: {
          ...sanitized.input,
          ...(decoded.expect === undefined
            ? {}
            : {
                expect: {
                  ...(withoutTransientText(decoded.expect.text) === undefined
                    ? {}
                    : { text: decoded.expect.text }),
                  ...(decoded.expect.role === undefined ? {} : { role: decoded.expect.role }),
                  until: decoded.expect.until ?? "present",
                  ...(decoded.expect.timeoutMs === undefined
                    ? {}
                    : { timeoutMs: decoded.expect.timeoutMs }),
                },
              }),
        },
      };
    }

    if (toolName === "wait_for") {
      const decoded = Parse(WaitInput, input);
      const text = withoutTransientText(decoded.text);

      return {
        input: {
          kind: "wait_for",
          ...(text === undefined ? {} : { text }),
          ...(decoded.role === undefined ? {} : { role: decoded.role }),
          ...(decoded.until === undefined ? {} : { until: decoded.until }),
          ...(decoded.timeoutMs === undefined ? {} : { timeoutMs: decoded.timeoutMs }),
        },
        issues:
          decoded.ref === undefined && decoded.scopeRef === undefined && decoded.value === undefined
            ? []
            : ["Transient refs and exact values were not recorded; review the wait condition."],
      };
    }

    if (toolName === "launch_browser" || toolName === "navigate_browser") {
      Parse(BrowserInput, input);

      return {
        input: { kind: toolName, urlVariable: `url-${sequence}` },
        issues: ["The browser URL was not recorded; define and bind the generated variable."],
      };
    }

    if (toolName === "run_ui_segment") {
      const decoded = Parse(SegmentInput, input);
      return { input: { kind: "semantic_segment", ...decoded }, issues: [] };
    }

    if (toolName === "close_browser") {
      return {
        input: withheld("unsupported-input"),
        issues: ["Browser cleanup was observed but is not a replay step."],
      };
    }

    if (toolName === "evaluate_browser") {
      return {
        input: withheld("arbitrary-code"),
        issues: ["Arbitrary browser code is never recorded."],
      };
    }

    if (toolName === "expand_ui" || toolName === "inspect_ui" || toolName === "read_text") {
      return {
        input: withheld("transient-reference"),
        issues: ["A transient inspection reference was not recorded."],
      };
    }
  } catch {
    return {
      input: withheld("unsupported-input"),
      issues: ["The observed tool input failed strict decoding and was withheld."],
    };
  }

  return { input: withheld("unsupported-input"), issues: ["Unsupported tool input was withheld."] };
};

const isComputerUseTool = (toolName: string): boolean => COMPUTER_USE_TOOLS.has(toolName);

export const startRecording = (
  name: string,
  goal: string,
  sessionId: string,
  now = new Date(),
): ActiveRecording => ({
  id: crypto.randomUUID(),
  name,
  goal,
  sessionId,
  startedAt: now.toISOString(),
  pending: new Map(),
  completed: [],
  nextSequence: 1,
});

export const observeToolCall = (
  recording: ActiveRecording,
  event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: Record<string, unknown>;
  },
  now = new Date(),
): void => {
  if (!isComputerUseTool(event.toolName) || recording.pending.has(event.toolCallId)) return;
  const sequence = recording.nextSequence;
  recording.nextSequence += 1;
  const sanitized = sanitizeComputerUseInput(event.toolName, event.input, sequence);
  recording.pending.set(event.toolCallId, {
    sequence,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    startedAt: now.toISOString(),
    ...sanitized,
  });
};

export const observeToolResult = (
  recording: ActiveRecording,
  event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly isError: boolean;
    readonly details?: unknown;
  },
  now = new Date(),
): void => {
  const pending = recording.pending.get(event.toolCallId);

  if (pending === undefined || pending.toolName !== event.toolName) return;
  recording.pending.delete(event.toolCallId);
  let successful = !event.isError;

  try {
    if (successful && pending.toolName === "wait_for") {
      successful =
        typeof event.details === "object" &&
        event.details !== null &&
        "found" in event.details &&
        event.details.found === true &&
        (!("timedOut" in event.details) || event.details.timedOut !== true);
    } else if (successful && pending.toolName === "run_ui_segment") {
      const decoded = Parse(SegmentResult, event.details);
      if (pending.input.kind !== "semantic_segment") successful = false;
      else {
        successful =
          decoded.completed.length === pending.input.steps.length &&
          decoded.completed.every((entry, index) => {
            const planned =
              pending.input.kind === "semantic_segment" ? pending.input.steps[index] : undefined;
            if (planned === undefined || entry.step !== index + 1) return false;
            return "assert" in planned
              ? entry.kind === "assert" && entry.actionCount === 0
              : entry.kind === undefined && entry.actionCount === planned.actions.length;
          });
      }
    } else if (
      successful &&
      pending.toolName === "act_ui" &&
      pending.input.kind === "safe_actions" &&
      pending.input.expect !== undefined
    ) {
      Parse(ActResult, event.details);
    }
  } catch {
    successful = false;
  }

  recording.completed.push({
    ...pending,
    completedAt: now.toISOString(),
    outcome: successful ? "success" : "error",
  });
};

export const finishRecording = (recording: ActiveRecording, now = new Date()): WorkflowDraft => {
  const pendingIssues = [...recording.pending.values()].map(
    (call) =>
      `Tool call ${call.sequence} had not completed when recording stopped and was omitted.`,
  );

  const calls = recording.completed.toSorted((left, right) => left.sequence - right.sequence);

  return {
    format: "ziggy-computer-workflow-draft",
    formatVersion: 1,
    id: recording.id,
    name: recording.name,
    goal: recording.goal,
    sessionId: recording.sessionId,
    startedAt: recording.startedAt,
    stoppedAt: now.toISOString(),
    status: "review-required",
    calls,
    issues: [...calls.flatMap((call) => call.issues), ...pendingIssues],
  };
};
