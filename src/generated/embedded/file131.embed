/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Validation failures become Pi tool failures. */
/* oxlint-disable ziggy/no-unknown-parameters -- This exported function is the schema decoder for tool input. */
/* oxlint-disable ziggy/no-conditional-empty-object-spread -- Template resolution preserves exact optional schema fields. */
/* oxlint-disable ziggy/require-readable-spacing -- Validation and resolution predicates remain adjacent. */
import { Parse } from "typebox/value";
import {
  WorkflowDefinitionSchema,
  type PublishedWorkflow,
  type WorkflowDefinition,
} from "./schema.ts";

const transientPattern = /(?:@[ero][A-Za-z0-9._:-]*|stateId)/i;

const suspiciousVariablePattern = /(?:password|passwd|token|cookie|secret|otp|api[-_ ]?key)/i;
const templatePattern = /\{\{([a-z0-9]+(?:-[a-z0-9]+)*)\}\}/g;
const primaryModifierPattern = /^(?:CMD|COMMAND|CTRL|CONTROL|META)$/;
const secondaryModifierPattern = /^(?:SHIFT|ALT|OPTION)$/;
const controlKeyPattern =
  /^(?:ENTER|RETURN|ESC|ESCAPE|TAB|BACKSPACE|DELETE|FORWARDDELETE|ARROWUP|ARROWDOWN|ARROWLEFT|ARROWRIGHT|UP|DOWN|LEFT|RIGHT|HOME|END|PAGEUP|PAGEDOWN|F(?:[1-9]|1[0-9]|2[0-4]))$/;
const chordKeyPattern =
  /^(?:[A-Z0-9]|ENTER|RETURN|ESC|ESCAPE|TAB|BACKSPACE|DELETE|FORWARDDELETE|ARROWUP|ARROWDOWN|ARROWLEFT|ARROWRIGHT|UP|DOWN|LEFT|RIGHT|HOME|END|PAGEUP|PAGEDOWN|F(?:[1-9]|1[0-9]|2[0-4]))$/;

const isSafeKeypressChord = (keys: readonly string[]): boolean => {
  if (keys.length === 1) return controlKeyPattern.test(keys[0] ?? "");
  if (keys.length === 2 && secondaryModifierPattern.test(keys[0] ?? "")) {
    return controlKeyPattern.test(keys[1] ?? "");
  }
  if (!primaryModifierPattern.test(keys[0] ?? "") || !chordKeyPattern.test(keys.at(-1) ?? "")) {
    return false;
  }

  return keys.slice(1, -1).every((key) => secondaryModifierPattern.test(key));
};

export const validateWorkflowDefinition = (value: unknown): WorkflowDefinition => {
  const workflow = Parse(WorkflowDefinitionSchema, value);
  const variableIds = new Set<string>();

  for (const variable of workflow.variables) {
    if (variableIds.has(variable.id)) throw new Error(`Duplicate variable '${variable.id}'.`);
    variableIds.add(variable.id);

    if (suspiciousVariablePattern.test(variable.id) && !variable.secret) {
      throw new Error(`Variable '${variable.id}' looks sensitive and must set secret=true.`);
    }
  }

  for (const [index, step] of workflow.steps.entries()) {
    if (transientPattern.test(JSON.stringify(step))) {
      throw new Error(`Step ${index + 1} contains a transient computer-use reference.`);
    }

    if ("target" in step && step.target !== undefined && Object.keys(step.target).length === 0) {
      throw new Error(`Step ${index + 1} has an empty semantic target.`);
    }

    if (
      step.kind === "wait" &&
      step.condition.text === undefined &&
      step.condition.role === undefined
    ) {
      throw new Error(`Step ${index + 1} has an empty checkpoint condition.`);
    }

    if ("checkpoint" in step && step.checkpoint !== undefined) {
      if (step.checkpoint.text === undefined && step.checkpoint.role === undefined) {
        throw new Error(`Step ${index + 1} has an empty checkpoint.`);
      }
    }

    if (step.kind === "type" && !variableIds.has(step.value.variable)) {
      throw new Error(`Step ${index + 1} references unknown variable '${step.value.variable}'.`);
    }

    if (step.kind === "keypress" && !isSafeKeypressChord(step.keys)) {
      throw new Error(`Step ${index + 1} has an unsupported keypress chord.`);
    }

    if (
      (step.kind === "launch_browser" || step.kind === "navigate_browser") &&
      !variableIds.has(step.url.variable)
    ) {
      throw new Error(`Step ${index + 1} references unknown variable '${step.url.variable}'.`);
    }
  }

  for (const match of JSON.stringify(workflow.steps).matchAll(templatePattern)) {
    const variable = workflow.variables.find(({ id }) => id === match[1]);
    if (variable === undefined)
      throw new Error(`Template references unknown variable '${match[1]}'.`);
    if (variable.secret)
      throw new Error(`Secret variable '${variable.id}' cannot appear in semantic templates.`);
  }

  return workflow;
};

const resolveText = (text: string | undefined, bindings: Readonly<Record<string, string>>) =>
  text?.replace(templatePattern, (_template, id: string) => {
    const value = bindings[id];
    if (value === undefined || value.length === 0)
      throw new Error(`Missing nonsecret binding '${id}'.`);
    return value;
  });

export const resolveWorkflowTemplates = (
  workflow: WorkflowDefinition,
  bindings: Readonly<Record<string, string>>,
): WorkflowDefinition => {
  const steps = workflow.steps.map((step) => {
    if (step.kind === "find_roots")
      return {
        ...step,
        ...(step.text === undefined ? {} : { text: resolveText(step.text, bindings) }),
      };
    if (step.kind === "wait")
      return {
        ...step,
        condition: {
          ...step.condition,
          ...(step.condition.text === undefined
            ? {}
            : { text: resolveText(step.condition.text, bindings) }),
        },
      };
    if ("target" in step && step.target !== undefined) {
      const target = {
        ...step.target,
        ...(step.target.text === undefined
          ? {}
          : { text: resolveText(step.target.text, bindings) }),
      };
      return {
        ...step,
        target,
        ...("checkpoint" in step && step.checkpoint !== undefined
          ? {
              checkpoint: {
                ...step.checkpoint,
                ...(step.checkpoint.text === undefined
                  ? {}
                  : { text: resolveText(step.checkpoint.text, bindings) }),
              },
            }
          : {}),
      };
    }
    return step;
  });
  return validateWorkflowDefinition({ ...workflow, steps });
};

export const makePublishedWorkflow = (
  definition: WorkflowDefinition,
  sourceDraftId: string,
  now = new Date(),
): PublishedWorkflow => ({
  format: "ziggy-computer-workflow",
  formatVersion: 1,
  revision: crypto.randomUUID(),
  publishedAt: now.toISOString(),
  sourceDraftId,
  workflow: definition,
});
