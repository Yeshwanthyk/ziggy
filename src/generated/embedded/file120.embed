/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is this package's async boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- A segment must fail closed at the tool boundary. */
/* oxlint-disable ziggy/no-runtime-typeof, ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion -- Exported upstream tool results are unknown at this isolated package boundary and are checked before use. */
/* oxlint-disable ziggy/no-unsafe-dictionary-type, ziggy/no-known-value-widening -- Pi's executor contract requires open serialized parameter objects at the upstream bridge boundary. */
/* oxlint-disable ziggy/no-conditional-empty-object-spread -- The optional root is intentionally omitted from the upstream observe call. */
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SEGMENT_MAX_STEPS = 20;
const SEGMENT_MAX_ACTIONS = 100;
const PRIMARY_MODIFIERS = new Set(["CMD", "COMMAND", "CTRL", "CONTROL", "META"]);
const SECONDARY_MODIFIERS = new Set(["SHIFT", "ALT", "OPTION"]);
const CONTROL_KEYS = new Set([
  "ENTER",
  "RETURN",
  "ESC",
  "ESCAPE",
  "TAB",
  "BACKSPACE",
  "DELETE",
  "FORWARDDELETE",
  "ARROWUP",
  "ARROWDOWN",
  "ARROWLEFT",
  "ARROWRIGHT",
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "HOME",
  "END",
  "PAGEUP",
  "PAGEDOWN",
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
]);

const isSafeControlKeypress = (keys: readonly string[]): boolean => {
  const normalized = keys.map((key) => key.trim().toUpperCase());
  if (normalized.some((key) => key.length === 0)) return false;
  const modifiers = normalized.filter(
    (key) => PRIMARY_MODIFIERS.has(key) || SECONDARY_MODIFIERS.has(key),
  );
  const baseKeys = normalized.filter(
    (key) => !PRIMARY_MODIFIERS.has(key) && !SECONDARY_MODIFIERS.has(key),
  );
  if (baseKeys.length !== 1 || modifiers.length !== normalized.length - 1) return false;
  const base = baseKeys[0];
  if (base === undefined || normalized.length > 4) return false;
  if (CONTROL_KEYS.has(base)) return true;
  return /^[A-Z0-9]$/.test(base) && modifiers.some((key) => PRIMARY_MODIFIERS.has(key));
};

interface SemanticTarget {
  readonly text?: string;
  readonly role?: string;
  readonly capability?: string;
}

type RootKind = "window" | "menu" | "sheet" | "popover" | "dialog" | "browser_page";

interface RootQuery {
  readonly text?: string;
  readonly app?: string;
  readonly bundleId?: string;
  readonly kind?: RootKind;
}

interface SegmentCondition {
  readonly text?: string;
  readonly role?: string;
  readonly until: "present" | "absent";
  readonly timeoutMs?: number;
}

type SegmentAction =
  | {
      readonly action: "click";
      readonly button?: "left" | "right" | "middle";
      readonly clickCount?: number;
    }
  | { readonly action: "keypress"; readonly keys: readonly string[] }
  | { readonly action: "scroll"; readonly scrollX?: number; readonly scrollY?: number };

interface SegmentActionStep {
  readonly target: SemanticTarget;
  readonly actions: readonly SegmentAction[];
  readonly expect: SegmentCondition;
}

interface SegmentAssertionStep {
  readonly assert: SegmentCondition;
}

type SegmentStep = SegmentActionStep | SegmentAssertionStep;

export interface SegmentParameters {
  readonly root?: string;
  readonly rootQuery?: RootQuery;
  readonly steps: readonly SegmentStep[];
}

interface ToolDetails {
  readonly kind?: "browser_page";
  readonly capture?: { readonly stateId?: string };
  readonly stateId?: string;
  readonly totalMatches?: number;
  readonly matches?: readonly { readonly ref?: string }[];
  readonly windows?: readonly { readonly windowRef?: string }[];
  readonly found?: boolean;
  readonly timedOut?: boolean;
  readonly status?: string;
  readonly execution?: {
    readonly outcome?: "worked" | "didnt" | "unknown";
    readonly error?: unknown;
  };
}

type ToolExecutor = (
  toolCallId: string,
  parameters: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>>;

export interface SegmentBridge {
  readonly find: ToolExecutor;
  readonly observe: ToolExecutor;
  readonly search: ToolExecutor;
  readonly act: ToolExecutor;
  readonly wait: ToolExecutor;
}

const fail = (step: number, message: string): never => {
  throw new Error(`Segment stopped at step ${step}: ${message}`);
};

const assertRootQuery = (query: RootQuery): void => {
  const values = [query.text, query.app, query.bundleId];
  if (
    query.kind === undefined &&
    !values.some((value) => typeof value === "string" && value.trim().length > 0)
  ) {
    throw new Error("Segment rootQuery must include text, app, bundleId, or kind.");
  }
};

const throwIfAborted = (signal: AbortSignal | undefined, step: number): void => {
  if (signal?.aborted) fail(step, "execution was cancelled.");
};

const detailsOf = (result: AgentToolResult<unknown>, step: number, tool: string): ToolDetails => {
  const details = result.details;
  if (details === null || typeof details !== "object") {
    fail(step, `${tool} returned unknown state.`);
  }
  return details as ToolDetails;
};

const stateIdOf = (details: ToolDetails, step: number, tool: string): string => {
  const stateId = details.capture?.stateId ?? details.stateId;
  if (typeof stateId !== "string" || stateId.length === 0) {
    throw new Error(`Segment stopped at step ${step}: ${tool} returned no successor state.`);
  }
  return stateId;
};

const assertTarget = (target: SemanticTarget, step: number): void => {
  const values = [target.text, target.role, target.capability];
  if (!values.some((value) => typeof value === "string" && value.trim().length > 0)) {
    fail(step, "semantic target is empty.");
  }
};

const assertCondition = (condition: SegmentCondition, step: number): void => {
  if (!condition || (condition.until !== "present" && condition.until !== "absent")) {
    fail(step, "a present/absent condition is required.");
  }
  if (
    ![condition.text, condition.role].some((value) => typeof value === "string" && value.trim())
  ) {
    fail(step, "condition must include text or role.");
  }
};

const assertSafeAction = (action: SegmentAction, step: number): void => {
  if (action.action === "keypress") {
    if (!isSafeControlKeypress(action.keys)) {
      fail(
        step,
        "keypress must be one navigation/control key or an explicit modifier chord; text-producing keys are forbidden.",
      );
    }
    return;
  }
  if (action.action === "scroll") {
    if ((action.scrollX ?? 0) === 0 && (action.scrollY ?? 0) === 0) {
      fail(step, "scroll must have a non-zero delta.");
    }
    return;
  }
  if (action.action !== "click") fail(step, "action is not in the reversible semantic allowlist.");
};

export const validateSegment = (parameters: SegmentParameters): void => {
  if (parameters.root !== undefined && parameters.rootQuery !== undefined) {
    throw new Error("Segment must use either root or rootQuery, not both.");
  }
  if (parameters.rootQuery !== undefined) assertRootQuery(parameters.rootQuery);
  if (!Array.isArray(parameters.steps) || parameters.steps.length === 0) {
    throw new Error("Segment must contain at least one step.");
  }
  if (parameters.steps.length > SEGMENT_MAX_STEPS) {
    throw new Error(`Segment supports at most ${SEGMENT_MAX_STEPS} steps.`);
  }
  let actions = 0;
  for (const [index, step] of parameters.steps.entries()) {
    const stepNumber = index + 1;
    if ("assert" in step) {
      assertCondition(step.assert, stepNumber);
      continue;
    }
    assertTarget(step.target, stepNumber);
    assertCondition(step.expect, stepNumber);
    if (!Array.isArray(step.actions) || step.actions.length === 0 || step.actions.length > 20) {
      fail(stepNumber, "actions must contain 1-20 entries.");
    }
    actions += step.actions.length;
    for (const action of step.actions) assertSafeAction(action, stepNumber);
  }
  if (actions > SEGMENT_MAX_ACTIONS) {
    throw new Error(`Segment supports at most ${SEGMENT_MAX_ACTIONS} actions.`);
  }
};

const actionWithRef = (action: SegmentAction, ref: string): Record<string, unknown> => ({
  ...action,
  ref,
});

const assertActionWorked = (details: ToolDetails, step: number): void => {
  if (details.status !== "ok" && details.kind !== "browser_page") {
    fail(step, `act_ui returned non-success status '${details.status ?? "unknown"}'.`);
  }
  if (details.execution?.error !== undefined) fail(step, "act_ui reported a driver error.");
  if (details.execution?.outcome === "didnt" || details.execution?.outcome === "unknown") {
    fail(step, `act_ui outcome was '${details.execution.outcome}'.`);
  }
};

export const executeSegment = async (
  toolCallId: string,
  parameters: SegmentParameters,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  bridge: SegmentBridge,
): Promise<AgentToolResult<unknown>> => {
  validateSegment(parameters);
  const completed: Array<
    | { step: number; stateId: string; ref: string; actionCount: number }
    | { step: number; stateId: string; kind: "assert"; actionCount: 0 }
  > = [];

  for (const [index, step] of parameters.steps.entries()) {
    const stepNumber = index + 1;
    throwIfAborted(signal, stepNumber);
    let root = parameters.root;
    if (parameters.rootQuery !== undefined) {
      const found = await bridge.find(
        `${toolCallId}:find:${stepNumber}`,
        { ...parameters.rootQuery },
        signal,
        undefined,
        ctx,
      );
      const findDetails = detailsOf(found, stepNumber, "find_roots");
      const windows = findDetails.windows ?? [];
      if (findDetails.totalMatches !== 1 || windows.length !== 1) {
        fail(
          stepNumber,
          findDetails.totalMatches === 0
            ? "root query did not find a current window."
            : `root query is ambiguous (${String(findDetails.totalMatches ?? "unknown")} matches).`,
        );
      }
      const currentRoot = windows[0]?.windowRef;
      if (typeof currentRoot !== "string" || !/^@r[0-9]+$/u.test(currentRoot)) {
        fail(stepNumber, "root query returned no unique current @r window ref.");
      }
      root = currentRoot;
      throwIfAborted(signal, stepNumber);
    }
    const observed = await bridge.observe(
      `${toolCallId}:observe:${stepNumber}`,
      { ...(root ? { root } : {}), mode: "semantic" },
      signal,
      undefined,
      ctx,
    );
    const observedStateId = stateIdOf(
      detailsOf(observed, stepNumber, "observe_ui"),
      stepNumber,
      "observe_ui",
    );
    throwIfAborted(signal, stepNumber);

    if ("assert" in step) {
      const verified = await bridge.wait(
        `${toolCallId}:assert:${stepNumber}`,
        { stateId: observedStateId, ...step.assert },
        signal,
        undefined,
        ctx,
      );
      const verification = detailsOf(verified, stepNumber, "wait_for");
      if (verification.found !== true || verification.timedOut === true) {
        fail(stepNumber, "assertion was not satisfied.");
      }
      completed.push({
        step: stepNumber,
        stateId: stateIdOf(verification, stepNumber, "wait_for"),
        kind: "assert",
        actionCount: 0,
      });
      continue;
    }

    const searched = await bridge.search(
      `${toolCallId}:search:${stepNumber}`,
      { stateId: observedStateId, ...step.target },
      signal,
      undefined,
      ctx,
    );
    const searchDetails = detailsOf(searched, stepNumber, "search_ui");
    const matches = searchDetails.matches ?? [];
    if (searchDetails.totalMatches !== 1 || matches.length !== 1) {
      fail(
        stepNumber,
        searchDetails.totalMatches === 0
          ? "semantic target was not found."
          : `semantic target is ambiguous (${String(searchDetails.totalMatches ?? "unknown")} matches).`,
      );
    }
    const ref = matches[0]?.ref;
    if (typeof ref !== "string" || !ref.startsWith("@e")) {
      throw new Error(
        `Segment stopped at step ${stepNumber}: resolved target has no current semantic ref.`,
      );
    }

    throwIfAborted(signal, stepNumber);
    const acted = await bridge.act(
      `${toolCallId}:act:${stepNumber}`,
      {
        stateId: observedStateId,
        actions: step.actions.map((action) => actionWithRef(action, ref)),
        expect: step.expect,
      },
      signal,
      undefined,
      ctx,
    );
    const actionDetails = detailsOf(acted, stepNumber, "act_ui");
    assertActionWorked(actionDetails, stepNumber);
    const successorStateId = stateIdOf(actionDetails, stepNumber, "act_ui");
    throwIfAborted(signal, stepNumber);

    const verified = await bridge.wait(
      `${toolCallId}:verify:${stepNumber}`,
      { stateId: successorStateId, ...step.expect },
      signal,
      undefined,
      ctx,
    );
    const verification = detailsOf(verified, stepNumber, "wait_for");
    if (verification.found !== true || verification.timedOut === true) {
      fail(stepNumber, "postcondition was not satisfied.");
    }
    completed.push({
      step: stepNumber,
      stateId: stateIdOf(verification, stepNumber, "wait_for"),
      ref,
      actionCount: step.actions.length,
    });
  }

  const details = { tool: "run_ui_segment", status: "completed", completed };
  return {
    content: [
      {
        type: "text",
        text: `Completed ${completed.length} semantic segment step${completed.length === 1 ? "" : "s"}; every postcondition was verified.`,
      },
    ],
    details,
  };
};
