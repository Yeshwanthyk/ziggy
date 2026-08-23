/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Validation failures become Pi tool failures. */
/* oxlint-disable ziggy/no-unknown-parameters -- This exported function is the schema decoder for tool input. */
import { Parse } from "typebox/value";
import {
  WorkflowDefinitionSchema,
  type PublishedWorkflow,
  type WorkflowDefinition,
} from "./schema.ts";

const transientPattern = /(?:@[ero][A-Za-z0-9._:-]*|stateId)/i;
const suspiciousVariablePattern = /(?:password|passwd|token|cookie|secret|otp|api[-_ ]?key)/i;

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
    if (
      (step.kind === "launch_browser" || step.kind === "navigate_browser") &&
      !variableIds.has(step.url.variable)
    ) {
      throw new Error(`Step ${index + 1} references unknown variable '${step.url.variable}'.`);
    }
  }
  return workflow;
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
