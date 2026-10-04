import { basename } from "node:path";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { SessionTools } from "../session";
import type { ExtensionsApi } from "./service";
import type { ExtensionDiagnostic, ExtensionError, SkippedPackage } from "./types";

const MAX_ITEMS = 64;

const MAX_OUTPUT = 20_000;

const id = Type.String({ minLength: 1, maxLength: 96, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" });

const source = Type.Optional(Type.Union([Type.Literal("shelf"), Type.Literal("catalog")]));

const strict = { additionalProperties: false } as const;

const variants = Type.Union([
  Type.Object({ action: Type.Literal("list") }, strict),
  Type.Object({ action: Type.Literal("add"), id, source }, strict),
  Type.Object({ action: Type.Literal("remove"), id, source }, strict),
  Type.Object({ action: Type.Literal("validate") }, strict),
]);

// Providers want a top-level object schema, and Anthropic keeps only its `properties` and
// `required`, so every branch's fields are listed flat too; validation still runs each branch.
const parameters = Type.Unsafe<Static<typeof variants>>({
  ...variants,
  type: "object",
  properties: {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("add"),
      Type.Literal("remove"),
      Type.Literal("validate"),
    ]),
    id,
    source: Type.Union([Type.Literal("shelf"), Type.Literal("catalog")]),
  },
  required: ["action"],
});

type Action = Static<typeof parameters>;

type Operation = Action["action"] | "input";

/** What the model reads back: `ok` is the only success signal. */
type Details =
  | {
      readonly ok: true;
      readonly operation: Operation;
      readonly code: string;
      readonly message: string;
      readonly selectionChanged: boolean;
      readonly id?: string;
      readonly result: unknown;
    }
  | {
      readonly ok: false;
      readonly operation: Operation;
      readonly stage: string;
      readonly code: string;
      readonly message: string;
      readonly selectionChanged: false;
      readonly id?: string;
      readonly diagnostics?: ReadonlyArray<ExtensionDiagnostic>;
    };

const bounded = (value: string, maximum: number) =>
  [
    ...value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  ]
    .slice(0, maximum)
    .join("");

const failureFields = (failure: ExtensionError) => {
  switch (failure._tag) {
    case "ProfileExtensionInvalid":
      return { stage: "validate", code: "invalid" };
    case "ProfileFileSystemError":
      return { stage: "filesystem", code: failure.code ?? "filesystem_error" };
    case "ExtensionLoadFailed":
      return { stage: failure.stage, code: "preflight_failed", diagnostics: failure.diagnostics };
    case "ExtensionLockFailed":
      return { stage: "lock", code: "lock_failed" };
  }
};

const text = (details: Details): string => {
  if (!details.ok) {
    const diagnostics = details.diagnostics
      ?.slice(0, 8)
      .map((item) => `${item.source}: ${item.message}`)
      .join("; ");

    return `ERROR: ${details.operation} failed [stage=${details.stage}; code=${details.code}]: ${details.message}${diagnostics ? `; diagnostics: ${diagnostics}` : ""}`;
  }

  return JSON.stringify(details);
};

const reply = (details: Details): AgentToolResult<Details> => ({
  content: [{ type: "text", text: bounded(text(details), MAX_OUTPUT) }],
  details,
});

interface Health {
  readonly broken: ReadonlyArray<SkippedPackage>;
  readonly healthWarning: boolean;
}

const unknownHealth: Health = { broken: [], healthWarning: true };

const listing = (extensions: ExtensionsApi, profilePath: string) =>
  Effect.gen(function* () {
    const selection = yield* extensions.listForProfile(profilePath);

    const health = yield* extensions.health(profilePath).pipe(
      Effect.map((value): Health => ({ broken: value.skipped, healthWarning: false })),
      Effect.catch((failure) =>
        Effect.logWarning("Profile extension health inspection failed", { failure }).pipe(
          Effect.as(unknownHealth),
        ),
      ),
    );

    const broken = health.broken.map((item) => item.id).join(", ");

    return {
      ok: true,
      operation: "list",
      code: "listed",
      message: `listed ${selection.available.length} Profile extension${selection.available.length === 1 ? "" : "s"}${broken ? `; BROKEN packages skipped: ${broken}` : ""}${health.healthWarning ? "; WARNING: package health could not be inspected" : ""}`,
      selectionChanged: false,
      result: {
        available: selection.available.slice(0, MAX_ITEMS).map((choice) => ({
          ...choice,
          description: bounded(choice.description, 240),
        })),
        broken: health.broken.slice(0, 16),
        selected: selection.selected.slice(0, MAX_ITEMS),
        healthWarning: health.healthWarning,
        truncated: selection.available.length > MAX_ITEMS || selection.selected.length > MAX_ITEMS,
      },
    } satisfies Details;
  });

const run = (
  extensions: ExtensionsApi,
  profilePath: string,
  params: Action,
): Effect.Effect<Details, ExtensionError> => {
  const profile = { path: profilePath, name: basename(profilePath) };

  switch (params.action) {
    case "list":
      return listing(extensions, profilePath);
    case "add":
      return Effect.map(extensions.add(profile, params.id), (result) => ({
        ok: true,
        operation: "add",
        id: result.id,
        code: result.changed ? "selected" : "already_selected",
        message: `${result.changed ? `selected Profile extension '${result.id}'` : `Profile extension '${result.id}' is already selected`}; open sessions need a reopen or a resident restart (ziggy serve restart <profile>)`,
        selectionChanged: result.changed,
        result: { id: result.id, changed: result.changed, selected: result.selected },
      }));
    case "remove":
      return Effect.map(extensions.remove(profile, params.id), (result) => ({
        ok: true,
        operation: "remove",
        id: result.id,
        code: result.changed ? "removed" : "not_selected",
        message: result.changed
          ? `removed Profile extension '${result.id}'`
          : `Profile extension '${result.id}' is not selected`,
        selectionChanged: result.changed,
        result: { id: result.id, changed: result.changed, selected: result.selected },
      }));
    case "validate":
      return Effect.map(extensions.validate(profile), (result) => ({
        ok: true,
        operation: "validate",
        code: "validated",
        message: "validated Profile extensions",
        selectionChanged: false,
        result: { ...result, selected: result.selected.slice(0, MAX_ITEMS) },
      }));
  }
};

const failed = (params: Action, failure: ExtensionError): Details => {
  const fields = failureFields(failure);

  const base: Details = {
    ok: false,
    operation: params.action,
    stage: fields.stage,
    code: fields.code,
    message: bounded(failure.message, 360) || "extension operation failed",
    selectionChanged: false,
  };

  const details: Details =
    fields.diagnostics === undefined ? base : { ...base, diagnostics: fields.diagnostics };

  return params.action === "add" || params.action === "remove"
    ? { ...details, id: params.id }
    : details;
};

/** The `profile_extensions` tool: the model's only way to change its Profile's packages. */
export const extensionTools =
  (extensions: ExtensionsApi): SessionTools =>
  ({ profilePath }) =>
    Effect.succeed([
      defineTool({
        name: "profile_extensions",
        label: "profile_extensions",
        description:
          "List, add, remove, or validate Profile extensions and Agent Plugins in-process. Add and remove accept only existing shelf, plugin (plugins/<id>/) or catalog IDs; do not pass paths or GitHub URLs.",
        promptSnippet: "profile_extensions(action, id) — manage Profile extensions in-process",
        promptGuidelines: [
          "Use profile_extensions for extension lifecycle changes instead of Bash, Ziggy commands, or direct extensions.json edits.",
          "For add and remove, use an existing lowercase shelf, plugin or catalog ID; GitHub URLs are not supported by this tool.",
          "A plugin's MCP servers and skills reach sessions opened after the change; never ask for or handle secret values, the user sets them with `ziggy plugin secret set`.",
          "Treat success as true only when the structured tool result has ok=true.",
        ],
        executionMode: "sequential",
        parameters,
        execute(_toolCallId, params, signal) {
          if (!Value.Check(parameters, params)) {
            return Promise.resolve(
              reply({
                ok: false,
                operation: "input",
                stage: "input",
                code: "invalid_input",
                message:
                  "invalid profile_extensions input; use a strict list, add, remove, or validate action",
                selectionChanged: false,
              }),
            );
          }

          const program = run(extensions, profilePath, params).pipe(
            Effect.match({
              onFailure: (failure) => reply(failed(params, failure)),
              onSuccess: reply,
            }),
          );

          // oxlint-disable-next-line ziggy-effect/no-effect-execution-boundary -- Pi requires a Promise-returning tool callback; this is the adapter bridge.
          return Effect.runPromise(program, { signal });
        },
      }),
    ]);
