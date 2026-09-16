import type { WorkflowDefinition } from "./schema.ts";

interface SegmentCondition {
  readonly text?: string;
  readonly role?: string;
  readonly until: "present" | "absent";
  readonly timeoutMs?: number;
}

interface CompatibleActionStep {
  readonly target: { readonly text?: string; readonly role?: string; readonly capability?: string };
  readonly actions: readonly CompatibleSegmentAction[];
  readonly expect: SegmentCondition;
}

interface CompatibleAssertionStep {
  readonly assert: SegmentCondition;
}

type CompatibleSegmentStep = CompatibleActionStep | CompatibleAssertionStep;

interface MutableSemanticTarget {
  text?: string;
  role?: string;
  capability?: string;
}

type CompatibleSegmentAction =
  | {
      action: "click";
      button?: "left" | "right" | "middle";
      clickCount?: number;
    }
  | { action: "keypress"; keys: readonly string[] }
  | { action: "scroll"; scrollX?: number; scrollY?: number };

export interface WorkflowExecutionPlan {
  readonly tool: "run_ui_segment";
  readonly input: {
    readonly rootQuery?: RootQuery;
    readonly steps: readonly CompatibleSegmentStep[];
  };
  readonly sourceSteps: readonly number[];
}

interface RootQuery {
  text?: string;
  app?: string;
  bundleId?: string;
  kind?: "window" | "menu" | "sheet" | "popover" | "dialog" | "browser_page";
}

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

export const normalizeSafeControlKeypress = (
  keys: readonly string[],
): readonly string[] | undefined => {
  const normalized = keys.map((key) => key.trim().toUpperCase());
  if (normalized.some((key) => key.length === 0)) return undefined;
  const modifiers = normalized.filter(
    (key) => PRIMARY_MODIFIERS.has(key) || SECONDARY_MODIFIERS.has(key),
  );
  const baseKeys = normalized.filter(
    (key) => !PRIMARY_MODIFIERS.has(key) && !SECONDARY_MODIFIERS.has(key),
  );
  if (baseKeys.length !== 1 || modifiers.length !== normalized.length - 1) return undefined;
  const base = baseKeys[0];
  if (base === undefined) return undefined;
  if (CONTROL_KEYS.has(base)) return normalized.length <= 4 ? normalized : undefined;
  if (!/^[A-Z0-9]$/.test(base)) return undefined;
  if (!modifiers.some((key) => PRIMARY_MODIFIERS.has(key))) return undefined;
  return normalized.length >= 2 && normalized.length <= 4 ? normalized : undefined;
};

interface ManualWorkflowStep {
  readonly sourceStep: number;
  readonly reason: string;
}

export interface CompiledWorkflowExecution {
  readonly segments: readonly WorkflowExecutionPlan[];
  readonly manual: readonly ManualWorkflowStep[];
}

const segmentTarget = (target: {
  readonly text?: string;
  readonly role?: string;
  readonly capability?: string;
}): CompatibleActionStep["target"] => {
  const projected: MutableSemanticTarget = {};
  if (target.text !== undefined) projected.text = target.text;
  if (target.role !== undefined) projected.role = target.role;
  if (target.capability !== undefined) projected.capability = target.capability;
  return projected;
};

export const compileExecutionPlan = (workflow: WorkflowDefinition): CompiledWorkflowExecution => {
  const segments: WorkflowExecutionPlan[] = [];
  let compatible: CompatibleSegmentStep[] = [];
  let sourceSteps: number[] = [];
  const manual: ManualWorkflowStep[] = [];
  let rootQuery: RootQuery | undefined;

  const flushSegment = (): void => {
    if (compatible.length === 0) return;
    segments.push({
      tool: "run_ui_segment",
      input: rootQuery === undefined ? { steps: compatible } : { rootQuery, steps: compatible },
      sourceSteps,
    });
    compatible = [];
    sourceSteps = [];
  };

  for (const [index, step] of workflow.steps.entries()) {
    const sourceStep = index + 1;
    if (step.kind === "find_roots") {
      flushSegment();
      const nextRootQuery: RootQuery = {};
      if (step.text !== undefined) nextRootQuery.text = step.text;
      if (step.app !== undefined) nextRootQuery.app = step.app;
      if (step.bundleId !== undefined) nextRootQuery.bundleId = step.bundleId;
      if (step.rootKind !== undefined) nextRootQuery.kind = step.rootKind;
      if (Object.keys(nextRootQuery).length === 0) {
        rootQuery = undefined;
        manual.push({
          sourceStep,
          reason: "This find_roots setup has no durable root query.",
        });
      } else {
        rootQuery = nextRootQuery;
      }
      continue;
    }
    if (step.kind === "observe") continue;
    if (step.kind === "wait") {
      if (rootQuery === undefined) {
        manual.push({
          sourceStep,
          reason: "This assertion has no active durable find_roots query.",
        });
        continue;
      }
      compatible.push({ assert: step.condition });
      sourceSteps.push(sourceStep);
      continue;
    }
    if (step.kind === "click" && step.checkpoint !== undefined) {
      if (rootQuery === undefined) {
        manual.push({
          sourceStep,
          reason: "This action has no active durable find_roots query.",
        });
        continue;
      }
      const target = segmentTarget(step.target);
      if (Object.keys(target).length === 0) {
        manual.push({
          sourceStep,
          reason:
            "An app-only action target is not a semantic control target; use app in find_roots.",
        });
        continue;
      }
      const action: CompatibleSegmentAction = { action: "click" };
      if (step.button !== undefined) action.button = step.button;
      if (step.clickCount !== undefined) action.clickCount = step.clickCount;
      compatible.push({
        target,
        actions: [action],
        expect: step.checkpoint,
      });
      sourceSteps.push(sourceStep);
      continue;
    }
    if (
      (step.kind === "keypress" || step.kind === "scroll") &&
      step.target !== undefined &&
      step.checkpoint !== undefined
    ) {
      if (rootQuery === undefined) {
        manual.push({
          sourceStep,
          reason: "This action has no active durable find_roots query.",
        });
        continue;
      }
      const target = segmentTarget(step.target);
      if (Object.keys(target).length === 0) {
        manual.push({
          sourceStep,
          reason:
            "An app-only action target is not a semantic control target; use app in find_roots.",
        });
        continue;
      }
      let action: CompatibleSegmentAction;
      if (step.kind === "keypress") {
        const keys = normalizeSafeControlKeypress(step.keys);
        if (keys === undefined) {
          manual.push({
            sourceStep,
            reason: "Text-producing keypresses are not replayable; use a user-entered variable.",
          });
          continue;
        }
        action = { action: "keypress", keys };
      } else {
        action = { action: "scroll" };
        if (step.scrollX !== undefined) action.scrollX = step.scrollX;
        if (step.scrollY !== undefined) action.scrollY = step.scrollY;
      }
      compatible.push({
        target,
        actions: [action],
        expect: step.checkpoint,
      });
      sourceSteps.push(sourceStep);
      continue;
    }

    const reason =
      step.kind === "type"
        ? "Text and secret values are never accepted by run_ui_segment; the user must enter the value directly."
        : "This step lacks a semantic target with a mandatory postcondition or is not in the segment allowlist.";
    manual.push({ sourceStep, reason });
  }

  flushSegment();

  return {
    segments,
    manual,
  };
};
