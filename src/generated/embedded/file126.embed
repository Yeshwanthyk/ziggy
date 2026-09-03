/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Approval invariant failures become Pi tool failures. */
import type { PublishApproval, WorkflowDefinition } from "./schema.ts";

export const makePublishApproval = (input: {
  readonly workflow: WorkflowDefinition;
  readonly sourceDraftId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly preparedAtUserInput: number;
  readonly now?: Date;
}): PublishApproval => ({
  format: "ziggy-computer-workflow-publish-approval",
  formatVersion: 1,
  id: crypto.randomUUID(),
  sourceDraftId: input.sourceDraftId,
  sessionId: input.sessionId,
  cwd: input.cwd,
  preparedAtUserInput: input.preparedAtUserInput,
  preparedAt: (input.now ?? new Date()).toISOString(),
  workflow: input.workflow,
});

export const assertPublishApproval = (
  approval: PublishApproval,
  context: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly userInput: number;
  },
): void => {
  if (context.sessionId !== approval.sessionId) {
    throw new Error("Workflow publish approval belongs to a different session.");
  }
  if (context.cwd !== approval.cwd) {
    throw new Error("Workflow publish approval belongs to a different Profile directory.");
  }
  if (context.userInput <= approval.preparedAtUserInput) {
    throw new Error("Workflow publishing requires a newer user response after preparation.");
  }
};
