import { basename } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type {
  ProfileExtensionError,
  ProfileExtensionListing,
  ProfileExtensionMutation,
  ProfileExtensionValidation,
  ProfileExtensionsApi,
} from "../../domain/profile-extension";
import type { ProfileTarget } from "../../domain/profile";

export const PROFILE_EXTENSIONS_MAX_ID_CODE_POINTS = 96;
export const PROFILE_EXTENSIONS_MAX_MESSAGE_CODE_POINTS = 360;
export const PROFILE_EXTENSIONS_MAX_CODE_CODE_POINTS = 64;
export const PROFILE_EXTENSIONS_MAX_LIST_ITEMS = 64;
export const PROFILE_EXTENSIONS_MAX_DESCRIPTION_CODE_POINTS = 240;
export const PROFILE_EXTENSIONS_MAX_OUTPUT_CODE_POINTS = 20_000;

const extensionId = Type.String({
  minLength: 1,
  maxLength: PROFILE_EXTENSIONS_MAX_ID_CODE_POINTS,
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
});

const extensionSource = Type.Union([Type.Literal("shelf"), Type.Literal("catalog")]);
const toolSource = Type.String({ minLength: 1, maxLength: 240 });

export const PROFILE_EXTENSIONS_MAX_SOURCE_CODE_POINTS = 240;

const profileExtensionsParameterVariants = Type.Union([
  Type.Object(
    {
      action: Type.Literal("list"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("add"),
      id: extensionId,
      source: Type.Optional(extensionSource),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("remove"),
      id: extensionId,
      source: Type.Optional(extensionSource),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("validate"),
    },
    { additionalProperties: false },
  ),
]);

// Pi providers expect a top-level object schema. Every branch remains strict;
// this only adds the provider-facing object marker to the discriminated union.
export const profileExtensionsParameters = Type.Unsafe<
  Static<typeof profileExtensionsParameterVariants>
>({
  ...profileExtensionsParameterVariants,
  type: "object",
});

export type ProfileExtensionsAction = Static<typeof profileExtensionsParameters>;
export type ProfileExtensionToolSource = Static<typeof extensionSource>;

const toolOperation = Type.Union([
  Type.Literal("input"),
  Type.Literal("list"),
  Type.Literal("add"),
  Type.Literal("remove"),
  Type.Literal("validate"),
]);

const toolStage = Type.Union([
  Type.Literal("input"),
  Type.Literal("catalog"),
  Type.Literal("resolve"),
  Type.Literal("download"),
  Type.Literal("checksum"),
  Type.Literal("archive"),
  Type.Literal("validation"),
  Type.Literal("validation"),
  Type.Literal("validate"),
  Type.Literal("filesystem"),
  Type.Literal("resources"),
  Type.Literal("extensions"),
  Type.Literal("skills"),
  Type.Literal("services"),
  Type.Literal("lock"),
  Type.Literal("rollback"),
  Type.Literal("complete"),
]);

const toolCode = Type.String({
  minLength: 1,
  maxLength: PROFILE_EXTENSIONS_MAX_CODE_CODE_POINTS,
  pattern: "^[A-Za-z0-9_.-]+$",
});

const toolMessage = Type.String({
  minLength: 1,
  maxLength: PROFILE_EXTENSIONS_MAX_MESSAGE_CODE_POINTS,
});

const boundedSelectedIds = Type.Array(extensionId, {
  maxItems: PROFILE_EXTENSIONS_MAX_LIST_ITEMS,
});

const listItem = Type.Object(
  {
    id: extensionId,
    description: Type.String({
      minLength: 1,
      maxLength: PROFILE_EXTENSIONS_MAX_DESCRIPTION_CODE_POINTS,
    }),
    kind: Type.Union([
      Type.Literal("skill"),
      Type.Literal("code"),
      Type.Literal("skill+code"),
      Type.Literal("remote"),
    ]),
    source: Type.Union([
      Type.Literal("bundled"),
      Type.Literal("remote-approved"),
      Type.Literal("profile"),
    ]),
  },
  { additionalProperties: false },
);

const listResult = Type.Object(
  {
    available: Type.Array(listItem, { maxItems: PROFILE_EXTENSIONS_MAX_LIST_ITEMS }),
    selected: boundedSelectedIds,
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

const mutationResult = Type.Object(
  {
    id: extensionId,
    changed: Type.Boolean(),
    selected: Type.Boolean(),
  },
  { additionalProperties: false },
);

const validationResult = Type.Object(
  {
    selected: boundedSelectedIds,
    preflight: Type.Object(
      {
        extensionPathCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
        skillPathCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
        extensionFactoryCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
      },
      { additionalProperties: false },
    ),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

const toolResultData = Type.Union([listResult, mutationResult, validationResult]);

const toolDetailsSuccess = Type.Object(
  {
    ok: Type.Literal(true),
    operation: toolOperation,
    stage: toolStage,
    id: Type.Optional(extensionId),
    source: Type.Optional(toolSource),
    code: toolCode,
    message: toolMessage,
    selectionChanged: Type.Boolean(),
    result: toolResultData,
  },
  { additionalProperties: false },
);

const toolDetailsFailure = Type.Object(
  {
    ok: Type.Literal(false),
    operation: toolOperation,
    stage: toolStage,
    id: Type.Optional(extensionId),
    source: Type.Optional(toolSource),
    code: toolCode,
    message: toolMessage,
    selectionChanged: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const profileExtensionToolDetailsSchema = Type.Union([
  toolDetailsSuccess,
  toolDetailsFailure,
]);

export type ProfileExtensionToolDetails = Static<typeof profileExtensionToolDetailsSchema>;

export type ProfileExtensionTool = ToolDefinition<
  typeof profileExtensionsParameters,
  ProfileExtensionToolDetails
>;

export interface ProfileExtensionToolOptions {
  readonly profilePath: string;
  readonly repositoryRoot: string;
  readonly profileExtensions: ProfileExtensionsApi;
}

export type ProfileExtensionToolData = Static<typeof toolResultData>;

type ToolOperation = ProfileExtensionToolDetails["operation"];
type ToolStage = ProfileExtensionToolDetails["stage"];
type ToolSource = Static<typeof toolSource>;

interface BoundedIds {
  readonly values: ReadonlyArray<string>;
  readonly truncated: boolean;
}

interface InputMetadata {
  readonly id: string | undefined;
  readonly source: ProfileExtensionToolSource | undefined;
}

interface ToolMetadata {
  readonly id: string | undefined;
  readonly source: string | undefined;
}

interface ToolDetailFields {
  readonly operation: ToolOperation;
  readonly stage: ToolStage;
  readonly code: string;
  readonly message: string;
  readonly selectionChanged: boolean;
  readonly id?: string;
  readonly source?: ToolSource;
}

interface MutableToolDetailFields {
  operation: ToolOperation;
  stage: ToolStage;
  code: string;
  message: string;
  selectionChanged: boolean;
  id?: string;
  source?: ToolSource;
}

interface FailureProjection {
  readonly stage: Exclude<ToolStage, "input" | "complete">;
  readonly code: string;
  readonly id?: string;
  readonly source?: string;
  readonly selectionChanged: boolean;
}

interface ProjectedListing {
  readonly result: Static<typeof listResult>;
  readonly availableCount: number;
}

type ProfileExtensionActionResult =
  | { readonly action: "list"; readonly value: ProfileExtensionListing }
  | { readonly action: "add"; readonly value: ProfileExtensionMutation }
  | { readonly action: "remove"; readonly value: ProfileExtensionMutation }
  | { readonly action: "validate"; readonly value: ProfileExtensionValidation };

const profileTarget = (profilePath: string): ProfileTarget => ({
  path: profilePath,
  name: basename(profilePath),
});

const boundedText = (value: string, maximum: number, fallback: string): string => {
  const normalized = value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = [...normalized].slice(0, maximum).join("");
  return bounded.length === 0 ? fallback : bounded;
};

const boundedId = (value: string): string => {
  const candidate = boundedText(
    value,
    PROFILE_EXTENSIONS_MAX_ID_CODE_POINTS,
    "invalid-extension-id",
  );
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate) ? candidate : "invalid-extension-id";
};

const boundedCode = (value: string, fallback: string): string => {
  const safe = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return boundedText(safe, PROFILE_EXTENSIONS_MAX_CODE_CODE_POINTS, fallback);
};

const boundedCount = (value: number): number =>
  Number.isInteger(value) && value >= 0 ? Math.min(value, 10_000) : 0;

const boundedIds = (ids: ReadonlyArray<string>): BoundedIds => ({
  values: ids.slice(0, PROFILE_EXTENSIONS_MAX_LIST_ITEMS).map(boundedId),
  truncated: ids.length > PROFILE_EXTENSIONS_MAX_LIST_ITEMS,
});

const inputMetadata = (params: ProfileExtensionsAction): InputMetadata => {
  if (params.action !== "add" && params.action !== "remove") {
    return { id: undefined, source: undefined };
  }
  return { id: params.id, source: params.source };
};

const withInputMetadata = (
  fields: Omit<ToolDetailFields, "id" | "source">,
  metadata: ToolMetadata,
): ToolDetailFields => {
  const result: MutableToolDetailFields = { ...fields };
  if (metadata.id !== undefined) result.id = boundedId(metadata.id);
  if (metadata.source !== undefined) {
    result.source = boundedText(
      metadata.source,
      PROFILE_EXTENSIONS_MAX_SOURCE_CODE_POINTS,
      "unavailable",
    );
  }
  return result;
};

const failureDetails = (
  operation: ToolOperation,
  metadata: ToolMetadata,
  stage: ToolStage,
  code: string,
  message: string,
  selectionChanged: boolean,
): ProfileExtensionToolDetails => ({
  ok: false,
  ...withInputMetadata(
    {
      operation,
      stage,
      code: boundedCode(code, "extension_operation_failed"),
      message: boundedText(
        message,
        PROFILE_EXTENSIONS_MAX_MESSAGE_CODE_POINTS,
        "extension operation failed",
      ),
      selectionChanged,
    },
    metadata,
  ),
});

const successDetails = (
  operation: Exclude<ToolOperation, "input">,
  metadata: ToolMetadata,
  code: string,
  message: string,
  selectionChanged: boolean,
  result: ProfileExtensionToolData,
): ProfileExtensionToolDetails => ({
  ok: true,
  ...withInputMetadata(
    {
      operation,
      stage: "complete",
      code: boundedCode(code, "extension_operation_succeeded"),
      message: boundedText(
        message,
        PROFILE_EXTENSIONS_MAX_MESSAGE_CODE_POINTS,
        "extension operation succeeded",
      ),
      selectionChanged,
    },
    metadata,
  ),
  result,
});

const failureProjection = (failure: ProfileExtensionError): FailureProjection => {
  switch (failure._tag) {
    case "ProfileExtensionInvalid":
      return { stage: "validate", code: "invalid", selectionChanged: false };
    case "ProfileFileSystemError":
      return {
        stage: "filesystem",
        code: failure.code ?? "filesystem_error",
        selectionChanged: false,
      };
    case "ExtensionCatalogInvalid":
      return {
        stage: "catalog",
        code: "catalog_invalid",
        source: failure.source,
        selectionChanged: false,
      };
    case "ExtensionCatalogUnavailable":
      return { stage: "catalog", code: "catalog_unavailable", selectionChanged: false };
    case "ExtensionCatalogInstallFailed":
      return {
        stage: failure.reason,
        code: "catalog_install_failed",
        id: failure.id,
        source: failure.path,
        selectionChanged: false,
      };
    case "ProfileExtensionPreflightFailed":
      return { stage: failure.stage, code: "preflight_failed", selectionChanged: false };
    case "ProfileExtensionLockFailed":
      return { stage: "lock", code: "lock_failed", selectionChanged: false };
    case "ProfileExtensionRollbackFailed":
      return { stage: "rollback", code: "rollback_failed", selectionChanged: true };
  }
};

const projectListing = (listing: ProfileExtensionListing): ProjectedListing => {
  const available = listing.available.slice(0, PROFILE_EXTENSIONS_MAX_LIST_ITEMS).map((choice) => ({
    id: boundedId(choice.id),
    description: boundedText(
      choice.description,
      PROFILE_EXTENSIONS_MAX_DESCRIPTION_CODE_POINTS,
      "Profile extension",
    ),
    kind: choice.kind,
    source: choice.source,
  }));
  const selected = boundedIds(listing.selected);
  return {
    availableCount: listing.available.length,
    result: {
      available,
      selected: [...selected.values],
      truncated: available.length < listing.available.length || selected.truncated,
    },
  };
};

const projectMutation = (mutation: ProfileExtensionMutation): Static<typeof mutationResult> => ({
  id: boundedId(mutation.id),
  changed: mutation.changed,
  selected: mutation.selected,
});

const projectValidation = (
  validation: ProfileExtensionValidation,
): Static<typeof validationResult> => {
  const selected = boundedIds(validation.selected);
  return {
    selected: [...selected.values],
    preflight: {
      extensionPathCount: boundedCount(validation.preflight.extensionPathCount),
      skillPathCount: boundedCount(validation.preflight.skillPathCount),
      extensionFactoryCount: boundedCount(validation.preflight.extensionFactoryCount),
    },
    truncated: selected.truncated,
  };
};

const actionEffect = (
  options: ProfileExtensionToolOptions,
  params: ProfileExtensionsAction,
): Effect.Effect<ProfileExtensionActionResult, ProfileExtensionError> => {
  const target = profileTarget(options.profilePath);
  switch (params.action) {
    case "list":
      return options.profileExtensions
        .listForProfile(options.profilePath, options.repositoryRoot)
        .pipe(
          Effect.map((value) => ({ action: "list", value }) satisfies ProfileExtensionActionResult),
        );
    case "add":
      return options.profileExtensions
        .add(target, options.repositoryRoot, params.id)
        .pipe(
          Effect.map((value) => ({ action: "add", value }) satisfies ProfileExtensionActionResult),
        );
    case "remove":
      return options.profileExtensions
        .remove(target, options.repositoryRoot, params.id)
        .pipe(
          Effect.map(
            (value) => ({ action: "remove", value }) satisfies ProfileExtensionActionResult,
          ),
        );
    case "validate":
      return options.profileExtensions
        .validate(target, options.repositoryRoot)
        .pipe(
          Effect.map(
            (value) => ({ action: "validate", value }) satisfies ProfileExtensionActionResult,
          ),
        );
  }
};

const successFor = (
  params: ProfileExtensionsAction,
  result: ProfileExtensionActionResult,
): ProfileExtensionToolDetails => {
  const metadata = inputMetadata(params);
  switch (result.action) {
    case "list": {
      const projected = projectListing(result.value);
      return successDetails(
        "list",
        metadata,
        "listed",
        `listed ${projected.availableCount} Profile extension${projected.availableCount === 1 ? "" : "s"}`,
        false,
        projected.result,
      );
    }
    case "add": {
      const mutation = result.value;
      return successDetails(
        "add",
        metadata,
        mutation.changed ? "selected" : "already_selected",
        mutation.changed
          ? `selected Profile extension '${boundedId(mutation.id)}'`
          : `Profile extension '${boundedId(mutation.id)}' is already selected`,
        mutation.changed,
        projectMutation(mutation),
      );
    }
    case "remove": {
      const mutation = result.value;
      return successDetails(
        "remove",
        metadata,
        mutation.changed ? "removed" : "not_selected",
        mutation.changed
          ? `removed Profile extension '${boundedId(mutation.id)}'`
          : `Profile extension '${boundedId(mutation.id)}' is not selected`,
        mutation.changed,
        projectMutation(mutation),
      );
    }
    case "validate": {
      const validation = result.value;
      return successDetails(
        "validate",
        metadata,
        "validated",
        "validated Profile extensions",
        false,
        projectValidation(validation),
      );
    }
  }
};

const contentFor = (details: ProfileExtensionToolDetails): string => {
  if (!details.ok) {
    return `ERROR: ${details.operation} failed [stage=${details.stage}; code=${details.code}]: ${details.message}`;
  }
  if (details.operation === "list" && "available" in details.result) {
    const available = details.result.available
      .map((extension) => `${extension.id} (${extension.source})`)
      .join(", ");
    const selected = details.result.selected.join(", ");
    return boundedText(
      `profile_extensions list: available=${available || "(none)"}; selected=${selected || "(none)"}${details.result.truncated ? "; result truncated" : ""}`,
      PROFILE_EXTENSIONS_MAX_OUTPUT_CODE_POINTS,
      "profile extension list unavailable",
    );
  }
  const encoded = JSON.stringify(details);
  return boundedText(
    encoded,
    PROFILE_EXTENSIONS_MAX_OUTPUT_CODE_POINTS,
    "profile extension result unavailable",
  );
};

const toolResult = (
  details: ProfileExtensionToolDetails,
): AgentToolResult<ProfileExtensionToolDetails> => ({
  content: [{ type: "text", text: contentFor(details) }],
  details,
});

const invalidInput = (): AgentToolResult<ProfileExtensionToolDetails> =>
  toolResult(
    failureDetails(
      "input",
      { id: undefined, source: undefined },
      "input",
      "invalid_input",
      "invalid profile_extensions input; use a strict list, add, remove, or validate action",
      false,
    ),
  );

export const createProfileExtensionTool = (
  profilePath: string,
  repositoryRoot: string,
  profileExtensions: ProfileExtensionsApi,
): ProfileExtensionTool => {
  const options: ProfileExtensionToolOptions = {
    profilePath,
    repositoryRoot,
    profileExtensions,
  };

  return {
    name: "profile_extensions",
    label: "profile_extensions",
    description:
      "List, add, remove, or validate Profile extensions in-process. Add and remove accept only existing shelf or catalog IDs; do not pass paths or GitHub URLs.",
    promptSnippet: "profile_extensions(action, id) — manage Profile extensions in-process",
    promptGuidelines: [
      "Use profile_extensions for extension lifecycle changes instead of Bash, Ziggy commands, or direct extensions.json edits.",
      "For add and remove, use an existing lowercase shelf or catalog ID; GitHub URLs are not supported by this tool.",
      "Treat success as true only when the structured tool result has ok=true.",
    ],
    executionMode: "sequential",
    parameters: profileExtensionsParameters,
    execute(_toolCallId, params, signal) {
      if (!Value.Check(profileExtensionsParameters, params)) {
        return Promise.resolve(invalidInput());
      }

      const program = actionEffect(options, params).pipe(
        Effect.match({
          onFailure: (failure) => {
            const metadata = inputMetadata(params);
            const projection = failureProjection(failure);
            const failureMetadata: ToolMetadata = {
              id: projection.id ?? metadata.id,
              source: projection.source ?? metadata.source,
            };
            return toolResult(
              failureDetails(
                params.action,
                failureMetadata,
                projection.stage,
                projection.code,
                failure.message,
                projection.selectionChanged,
              ),
            );
          },
          onSuccess: (result) => toolResult(successFor(params, result)),
        }),
      );

      // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning tool callback; this is the adapter bridge.
      return Effect.runPromise(program, { signal });
    },
  };
};

export const createProfileExtensionsTool = createProfileExtensionTool;
export const profileExtensionsToolParameters = profileExtensionsParameters;
export const profileExtensionsToolDetailsSchema = profileExtensionToolDetailsSchema;
