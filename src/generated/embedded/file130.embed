/* oxlint-disable ziggy/require-readable-spacing -- Declarative schemas are intentionally compact. */
import { Type, type Static } from "typebox";

const Id = Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", minLength: 1, maxLength: 80 });

const Text = Type.String({ minLength: 1, maxLength: 1_024 });

const ShortText = Type.String({ minLength: 1, maxLength: 256 });

const Timestamp = Type.String({ format: "date-time" });

const Button = Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]);

const PrimaryModifierKey = Type.String({ pattern: "^(?:CMD|COMMAND|CTRL|CONTROL|META)$" });

const SecondaryModifierKey = Type.String({ pattern: "^(?:SHIFT|ALT|OPTION)$" });

const ControlKey = Type.String({
  pattern:
    "^(?:ENTER|RETURN|ESC|ESCAPE|TAB|BACKSPACE|DELETE|FORWARDDELETE|ARROWUP|ARROWDOWN|ARROWLEFT|ARROWRIGHT|UP|DOWN|LEFT|RIGHT|HOME|END|PAGEUP|PAGEDOWN|F(?:[1-9]|1[0-9]|2[0-4]))$",
});

const ChordKey = Type.Union([ControlKey, Type.String({ pattern: "^[A-Z0-9]$" })]);

export const SafeKeypressKeysSchema = Type.Array(
  Type.Union([PrimaryModifierKey, SecondaryModifierKey, ChordKey]),
  { minItems: 1, maxItems: 4 },
);

const SemanticTargetSchema = Type.Object(
  {
    text: Type.Optional(ShortText),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    capability: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    app: Type.Optional(ShortText),
  },
  { additionalProperties: false },
);

const CheckpointSchema = Type.Object(
  {
    text: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    until: Type.Union([Type.Literal("present"), Type.Literal("absent")]),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
  },
  { additionalProperties: false },
);

const VariableSchema = Type.Object(
  {
    id: Id,
    description: Text,
    secret: Type.Boolean(),
    source: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
  },
  { additionalProperties: false },
);

const VariableReferenceSchema = Type.Object({ variable: Id }, { additionalProperties: false });

const StepMetadata = {
  checkpoint: Type.Optional(CheckpointSchema),
};

const WorkflowStepSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("find_roots"),
      text: Type.Optional(ShortText),
      app: Type.Optional(ShortText),
      bundleId: Type.Optional(ShortText),
      rootKind: Type.Optional(
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
  Type.Object(
    {
      kind: Type.Literal("observe"),
      mode: Type.Optional(
        Type.Union([Type.Literal("semantic"), Type.Literal("visual"), Type.Literal("fused")]),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("click"),
      target: SemanticTargetSchema,
      button: Type.Optional(Button),
      clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      ...StepMetadata,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("type"),
      target: Type.Optional(SemanticTargetSchema),
      value: VariableReferenceSchema,
      ...StepMetadata,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("keypress"),
      target: Type.Optional(SemanticTargetSchema),
      keys: SafeKeypressKeysSchema,
      ...StepMetadata,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("scroll"),
      target: Type.Optional(SemanticTargetSchema),
      scrollX: Type.Optional(Type.Number({ minimum: -20_000, maximum: 20_000 })),
      scrollY: Type.Optional(Type.Number({ minimum: -20_000, maximum: 20_000 })),
      ...StepMetadata,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("wait"),
      condition: CheckpointSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Union([Type.Literal("launch_browser"), Type.Literal("navigate_browser")]),
      url: VariableReferenceSchema,
      ...StepMetadata,
    },
    { additionalProperties: false },
  ),
]);

export const WorkflowDefinitionSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: Id,
    name: Text,
    description: Type.Optional(Type.String({ maxLength: 2_000 })),
    variables: Type.Array(VariableSchema, { maxItems: 50 }),
    steps: Type.Array(WorkflowStepSchema, { minItems: 1, maxItems: 200 }),
  },
  { additionalProperties: false },
);

export const PublishedWorkflowSchema = Type.Object(
  {
    format: Type.Literal("ziggy-computer-workflow"),
    formatVersion: Type.Literal(1),
    revision: Id,
    publishedAt: Timestamp,
    sourceDraftId: Id,
    workflow: WorkflowDefinitionSchema,
  },
  { additionalProperties: false },
);

const RecordedInputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("find_roots"),
      text: Type.Optional(ShortText),
      app: Type.Optional(ShortText),
      bundleId: Type.Optional(ShortText),
      rootKind: Type.Optional(
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
  Type.Object(
    {
      kind: Type.Literal("observe_ui"),
      mode: Type.Optional(
        Type.Union([Type.Literal("semantic"), Type.Literal("visual"), Type.Literal("fused")]),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("search_ui"),
      text: Type.Optional(ShortText),
      role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      capability: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("safe_actions"),
      expect: Type.Optional(CheckpointSchema),
      actions: Type.Array(
        Type.Union([
          Type.Object(
            {
              action: Type.Literal("keypress"),
              keys: SafeKeypressKeysSchema,
              target: Type.Union([Type.Literal("focused"), Type.Literal("requires-review")]),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              action: Type.Literal("scroll"),
              scrollX: Type.Optional(Type.Number()),
              scrollY: Type.Optional(Type.Number()),
              target: Type.Union([Type.Literal("root"), Type.Literal("requires-review")]),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              action: Type.Literal("variable-input"),
              variable: Id,
              target: Type.Union([Type.Literal("focused"), Type.Literal("requires-review")]),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              action: Type.Literal("requires-review"),
              reason: Type.Union([
                Type.Literal("transient-target"),
                Type.Literal("coordinate-action"),
                Type.Literal("unsupported-action"),
              ]),
            },
            { additionalProperties: false },
          ),
        ]),
        { minItems: 1, maxItems: 20 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("semantic_segment"),
      rootQuery: Type.Optional(
        Type.Object(
          {
            text: Type.Optional(ShortText),
            app: Type.Optional(ShortText),
            bundleId: Type.Optional(ShortText),
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
          Type.Object({ assert: CheckpointSchema }, { additionalProperties: false }),
          Type.Object(
            {
              target: SemanticTargetSchema,
              actions: Type.Array(
                Type.Union([
                  Type.Object(
                    {
                      action: Type.Literal("click"),
                      button: Type.Optional(Button),
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
              expect: CheckpointSchema,
            },
            { additionalProperties: false },
          ),
        ]),
        { minItems: 1, maxItems: 20 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("wait_for"),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      role: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      until: Type.Optional(Type.Union([Type.Literal("present"), Type.Literal("absent")])),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Union([Type.Literal("launch_browser"), Type.Literal("navigate_browser")]),
      urlVariable: Id,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("withheld"),
      reason: Type.Union([
        Type.Literal("transient-reference"),
        Type.Literal("arbitrary-code"),
        Type.Literal("unsupported-input"),
      ]),
    },
    { additionalProperties: false },
  ),
]);

const RecordedCallSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
    toolName: Type.String({ minLength: 1, maxLength: 128 }),
    startedAt: Timestamp,
    completedAt: Timestamp,
    outcome: Type.Union([Type.Literal("success"), Type.Literal("error")]),
    input: RecordedInputSchema,
    issues: Type.Array(Text, { maxItems: 40 }),
  },
  { additionalProperties: false },
);

export const WorkflowDraftSchema = Type.Object(
  {
    format: Type.Literal("ziggy-computer-workflow-draft"),
    formatVersion: Type.Literal(1),
    id: Id,
    name: Text,
    goal: Text,
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    startedAt: Timestamp,
    stoppedAt: Timestamp,
    status: Type.Literal("review-required"),
    calls: Type.Array(RecordedCallSchema, { maxItems: 1_000 }),
    issues: Type.Array(Text, { maxItems: 1_000 }),
  },
  { additionalProperties: false },
);

export const RunRecordSchema = Type.Object(
  {
    format: Type.Literal("ziggy-computer-workflow-run"),
    formatVersion: Type.Literal(1),
    id: Id,
    workflowId: Id,
    revision: Id,
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    preparedAt: Timestamp,
    status: Type.Literal("planned"),
    plannedSegmentCount: Type.Integer({ minimum: 0, maximum: 200 }),
    manualStepCount: Type.Integer({ minimum: 0, maximum: 200 }),
  },
  { additionalProperties: false },
);

export const WorkflowSaveCandidateSchema = Type.Object(
  {
    format: Type.Literal("ziggy-workflow-save-candidate"),
    formatVersion: Type.Literal(1),
    id: Id,
    candidateHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    verificationBindingsHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    sourceDraftId: Id,
    baseRevision: Type.Union([Id, Type.Null()]),
    createdAt: Timestamp,
    workflow: WorkflowDefinitionSchema,
    optimization: Type.Object(
      {
        removedRedundantObservations: Type.Integer({ minimum: 0, maximum: 200 }),
        removedRedundantRootLookups: Type.Integer({ minimum: 0, maximum: 200 }),
        segmentCount: Type.Integer({ minimum: 0, maximum: 200 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const WorkflowSaveProofSchema = Type.Object(
  {
    format: Type.Literal("ziggy-workflow-save-proof"),
    formatVersion: Type.Literal(1),
    id: Id,
    candidateId: Id,
    candidateHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    runSummaryId: Id,
    verifiedAt: Timestamp,
    outcome: Type.Literal("passed"),
  },
  { additionalProperties: false },
);

const TaskInputSchema = Type.Object(
  {
    id: Id,
    description: Text,
    default: Type.Optional(Type.String({ minLength: 1, maxLength: 8_192 })),
  },
  { additionalProperties: false },
);

const TaskCriterionSchema = Type.Object(
  {
    id: Id,
    description: Text,
    evidence: Type.Union([
      Type.Literal("tool-result"),
      Type.Literal("artifact"),
      Type.Literal("agent-assessment"),
    ]),
  },
  { additionalProperties: false },
);

export const GeneralTaskDefinitionSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: Id,
    name: Text,
    goal: Text,
    inputs: Type.Array(TaskInputSchema, { maxItems: 50 }),
    startContext: Type.Object(
      {
        kind: Type.Union([Type.Literal("browser"), Type.Literal("desktop")]),
        browserProfile: Type.Optional(ShortText),
        urlInput: Type.Optional(Id),
        app: Type.Optional(ShortText),
      },
      { additionalProperties: false },
    ),
    procedure: Type.Array(Text, { minItems: 1, maxItems: 100 }),
    output: Type.Object(
      {
        format: Type.Union([
          Type.Literal("text"),
          Type.Literal("json"),
          Type.Literal("artifact"),
          Type.Literal("artifacts"),
        ]),
        description: Text,
      },
      { additionalProperties: false },
    ),
    completionCriteria: Type.Array(TaskCriterionSchema, {
      minItems: 1,
      maxItems: 50,
    }),
  },
  { additionalProperties: false },
);

export const GeneralTaskCandidateSchema = Type.Object(
  {
    format: Type.Literal("ziggy-general-task-candidate"),
    formatVersion: Type.Literal(1),
    id: Id,
    candidateHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    sourceDraftId: Id,
    baseRevision: Type.Union([Id, Type.Null()]),
    createdAt: Timestamp,
    task: GeneralTaskDefinitionSchema,
  },
  { additionalProperties: false },
);

export const PublishedGeneralTaskSchema = Type.Object(
  {
    format: Type.Literal("ziggy-general-task"),
    formatVersion: Type.Literal(1),
    revision: Id,
    savedAt: Timestamp,
    sourceDraftId: Id,
    task: GeneralTaskDefinitionSchema,
  },
  { additionalProperties: false },
);

const TaskObservedCallSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    toolCallId: Type.String({ minLength: 1, maxLength: 256 }),
    toolName: Type.String({ minLength: 1, maxLength: 128 }),
    startedAt: Timestamp,
    completedAt: Type.Optional(Timestamp),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("unknown"),
    ]),
    resultDigest: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    input: RecordedInputSchema,
    issues: Type.Array(Text, { maxItems: 40 }),
    reconciliation: Type.Optional(
      Type.Object(
        {
          assessment: Text,
          evidenceToolCallIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
            minItems: 1,
            maxItems: 20,
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const TaskCriterionEvidenceSchema = Type.Object(
  {
    criterionId: Id,
    outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    toolCallIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 100 }),
    ),
    artifactPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 8_192 }), { maxItems: 100 }),
    ),
    artifacts: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({ minLength: 1, maxLength: 8_192 }),
            size: Type.Integer({ minimum: 0 }),
            sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
            modifiedAt: Timestamp,
          },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
    ),
    assessment: Type.Optional(Text),
    evidenceLabel: Type.Union([
      Type.Literal("observed-tool-result"),
      Type.Literal("verified-artifact"),
      Type.Literal("agent-assessed"),
    ]),
  },
  { additionalProperties: false },
);

export const GeneralTaskRunSchema = Type.Object(
  {
    format: Type.Literal("ziggy-general-task-run"),
    formatVersion: Type.Literal(1),
    id: Id,
    taskId: Id,
    candidateId: Type.Optional(Id),
    revision: Id,
    mode: Type.Union([Type.Literal("verification"), Type.Literal("run")]),
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    inputsHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    startedAt: Timestamp,
    updatedAt: Timestamp,
    state: Type.Union([
      Type.Literal("active"),
      Type.Literal("cancelled"),
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("incomplete"),
    ]),
    calls: Type.Array(TaskObservedCallSchema, { maxItems: 1_000 }),
    criteria: Type.Array(TaskCriterionEvidenceSchema, { maxItems: 50 }),
  },
  { additionalProperties: false },
);

const RunCheckSchema = Type.Object(
  {
    sourceStep: Type.Integer({ minimum: 1, maximum: 200 }),
    expected: CheckpointSchema,
    outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not-run")]),
  },
  { additionalProperties: false },
);

export const RunSummarySchema = Type.Object(
  {
    format: Type.Literal("ziggy-computer-workflow-run-summary"),
    formatVersion: Type.Literal(1),
    id: Id,
    workflowId: Id,
    revision: Id,
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    preparedAt: Timestamp,
    finishedAt: Timestamp,
    overall: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("incomplete"),
    ]),
    checks: Type.Array(RunCheckSchema, { maxItems: 200 }),
    segments: Type.Object(
      {
        planned: Type.Integer({ minimum: 0, maximum: 200 }),
        matched: Type.Integer({ minimum: 0, maximum: 200 }),
        passed: Type.Integer({ minimum: 0, maximum: 200 }),
        failed: Type.Integer({ minimum: 0, maximum: 200 }),
      },
      { additionalProperties: false },
    ),
    stopReason: Type.Union([
      Type.Literal("completed"),
      Type.Literal("manual-steps"),
      Type.Literal("tool-error"),
      Type.Literal("invalid-result"),
      Type.Literal("input-mismatch"),
      Type.Literal("unfinished-segments"),
    ]),
  },
  { additionalProperties: false },
);

export const PublishApprovalSchema = Type.Object(
  {
    format: Type.Literal("ziggy-computer-workflow-publish-approval"),
    formatVersion: Type.Literal(1),
    id: Id,
    sourceDraftId: Id,
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    cwd: Type.String({ minLength: 1, maxLength: 8_192 }),
    preparedAtUserInput: Type.Integer({ minimum: 0 }),
    preparedAt: Timestamp,
    workflow: WorkflowDefinitionSchema,
  },
  { additionalProperties: false },
);

export type WorkflowDefinition = Static<typeof WorkflowDefinitionSchema>;

export type PublishedWorkflow = Static<typeof PublishedWorkflowSchema>;

export type WorkflowDraft = Static<typeof WorkflowDraftSchema>;
export type WorkflowSaveCandidate = Static<typeof WorkflowSaveCandidateSchema>;
export type WorkflowSaveProof = Static<typeof WorkflowSaveProofSchema>;
export type GeneralTaskDefinition = Static<typeof GeneralTaskDefinitionSchema>;
export type GeneralTaskCandidate = Static<typeof GeneralTaskCandidateSchema>;
export type PublishedGeneralTask = Static<typeof PublishedGeneralTaskSchema>;
export type GeneralTaskRun = Static<typeof GeneralTaskRunSchema>;

export type RecordedCall = Static<typeof RecordedCallSchema>;

export type RecordedInput = Static<typeof RecordedInputSchema>;

export type RunRecord = Static<typeof RunRecordSchema>;

export type RunSummary = Static<typeof RunSummarySchema>;

export type PublishApproval = Static<typeof PublishApprovalSchema>;

export const WorkflowIdSchema = Id;
