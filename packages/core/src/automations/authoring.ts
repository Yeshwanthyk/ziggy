import { resolve } from "node:path";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import {
  createAutomationAuthoringNodeAdapter,
  type AutomationAuthoringNodeHooks,
  type AutomationNodeError,
} from "./authoring-node-adapter.ts";
import {
  type AutomationDefinition,
  isAutomationId,
  parseAutomationDefinition,
} from "./definition.ts";

export type AutomationAuthoringErrorCode =
  | "invalid-definition"
  | "not-found"
  | "conflict"
  | "operation-failed";

export class AutomationAuthoringError extends Schema.TaggedErrorClass<AutomationAuthoringError>(
  "@ziggy/core/automations/AutomationAuthoringError",
)("AutomationAuthoringError", {
  operation: Schema.String,
  code: Schema.Literals(["invalid-definition", "not-found", "conflict", "operation-failed"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface AutomationObservation {
  readonly definition: AutomationDefinition;
  readonly content: string;
  readonly revision: string;
}

export interface AutomationCreateRequest {
  readonly id: string;
  readonly content: string;
}

export interface AutomationUpdateRequest extends AutomationCreateRequest {
  readonly expectedRevision: string;
}

export interface AutomationDeleteRequest {
  readonly id: string;
  readonly expectedRevision: string;
}

/**
 * Revisions protect cooperative edits by hashing the exact on-disk bytes. Publication revalidates
 * bytes and bigint file identity immediately before its atomic mutation. Standard filesystem APIs
 * cannot close the final check-to-mutation race against an uncooperative writer running as the same
 * OS user; Profile ownership and same-UID process exclusion remain the outer security boundary.
 */
export interface AutomationAuthoringService {
  create(
    request: AutomationCreateRequest,
  ): Effect.Effect<AutomationObservation, AutomationAuthoringError>;
  update(
    request: AutomationUpdateRequest,
  ): Effect.Effect<AutomationObservation, AutomationAuthoringError>;
  delete(request: AutomationDeleteRequest): Effect.Effect<void, AutomationAuthoringError>;
  inspect(id: string): Effect.Effect<AutomationObservation, AutomationAuthoringError>;
  list(): Effect.Effect<ReadonlyArray<AutomationObservation>, AutomationAuthoringError>;
}

export interface AutomationAuthoringOptions {
  readonly profilePath: string;
  /** Deterministic adapter cutpoints for concurrency and fault-injection tests. */
  readonly nodeHooks?: AutomationAuthoringNodeHooks;
}

export class AutomationAuthoring extends Context.Service<
  AutomationAuthoring,
  AutomationAuthoringService
>()("@ziggy/core/automations/AutomationAuthoring") {
  static layer(options: AutomationAuthoringOptions) {
    return Layer.effect(this, makeAutomationAuthoring(options));
  }
}

const gates = new Map<string, Semaphore.Semaphore>();

export function makeAutomationAuthoring(
  options: AutomationAuthoringOptions,
): Effect.Effect<AutomationAuthoringService, AutomationAuthoringError> {
  return Effect.gen(function* () {
    const profilePath = resolve(options.profilePath);
    const node = createAutomationAuthoringNodeAdapter(profilePath, options.nodeHooks);
    let gate = gates.get(profilePath);
    if (gate === undefined) {
      gate = Semaphore.makeUnsafe(1);
      gates.set(profilePath, gate);
    }
    yield* Semaphore.withPermit(gate, mapNodeError("initialize", node.initialize));
    const serialized = <Value>(operation: Effect.Effect<Value, AutomationAuthoringError>) =>
      Semaphore.withPermit(gate, operation);
    const inspect = (id: string) => serialized(inspectAutomation(node, id));
    return AutomationAuthoring.of({
      create: (request) => serialized(createAutomation(node, request)),
      update: (request) => serialized(updateAutomation(node, request)),
      delete: (request) => serialized(deleteAutomation(node, request)),
      inspect,
      list: () => serialized(listAutomations(node)),
    });
  });
}

type NodeAdapter = ReturnType<typeof createAutomationAuthoringNodeAdapter>;

interface PreparedProposal {
  readonly definition: AutomationDefinition;
  readonly content: string;
  readonly bytes: Uint8Array;
}

function createAutomation(
  node: NodeAdapter,
  request: AutomationCreateRequest,
): Effect.Effect<AutomationObservation, AutomationAuthoringError> {
  return Effect.gen(function* () {
    const proposal = yield* prepareProposal("create", request.id, request.content);
    yield* mapNodeError("create", node.create(request.id, proposal.bytes));
    return observe(proposal.definition, proposal.content, proposal.bytes);
  });
}

function updateAutomation(
  node: NodeAdapter,
  request: AutomationUpdateRequest,
): Effect.Effect<AutomationObservation, AutomationAuthoringError> {
  return Effect.gen(function* () {
    const proposal = yield* prepareProposal("update", request.id, request.content);
    const current = yield* readCurrent(node, "update", request.id);
    yield* requireRevision("update", request.id, current, request.expectedRevision);
    yield* mapNodeError("update", node.update(request.id, proposal.bytes, current));
    return observe(proposal.definition, proposal.content, proposal.bytes);
  });
}

function deleteAutomation(
  node: NodeAdapter,
  request: AutomationDeleteRequest,
): Effect.Effect<void, AutomationAuthoringError> {
  return Effect.gen(function* () {
    yield* requireValidId("delete", request.id);
    const current = yield* readCurrent(node, "delete", request.id);
    yield* requireRevision("delete", request.id, current, request.expectedRevision);
    yield* mapNodeError("delete", node.delete(request.id, current));
  });
}

function inspectAutomation(
  node: NodeAdapter,
  id: string,
): Effect.Effect<AutomationObservation, AutomationAuthoringError> {
  return Effect.gen(function* () {
    yield* requireValidId("inspect", id);
    const bytes = yield* readCurrent(node, "inspect", id);
    const content = yield* decodeUtf8("inspect", id, bytes);
    const definition = yield* validateProposal("inspect", id, content);
    return observe(definition, content, bytes);
  });
}

function listAutomations(
  node: NodeAdapter,
): Effect.Effect<ReadonlyArray<AutomationObservation>, AutomationAuthoringError> {
  return Effect.gen(function* () {
    const names = yield* mapNodeError("list", node.listNames);
    const markdownNames = names.filter((name) => name.endsWith(".md"));
    return yield* Effect.forEach(markdownNames, (name) =>
      inspectAutomation(node, name.slice(0, -3)),
    );
  });
}

function validateProposal(
  operation: string,
  id: string,
  content: string,
): Effect.Effect<AutomationDefinition, AutomationAuthoringError> {
  return parseAutomationDefinition(id, content).pipe(
    Effect.mapError(
      (cause) =>
        new AutomationAuthoringError({
          operation,
          code: "invalid-definition",
          message: cause.message,
          cause,
        }),
    ),
  );
}

function prepareProposal(
  operation: string,
  id: string,
  content: string,
): Effect.Effect<PreparedProposal, AutomationAuthoringError> {
  return Effect.gen(function* () {
    const bytes = encodeUtf8(content);
    const roundTripped = yield* decodeUtf8(operation, id, bytes);
    if (roundTripped !== content) {
      return yield* new AutomationAuthoringError({
        operation,
        code: "invalid-definition",
        message: `Automation ${id} content is not losslessly encodable as UTF-8`,
      });
    }
    const definition = yield* validateProposal(operation, id, roundTripped);
    return { definition, content: roundTripped, bytes };
  });
}

function readCurrent(
  node: NodeAdapter,
  operation: string,
  id: string,
): Effect.Effect<Uint8Array, AutomationAuthoringError> {
  return mapNodeError(operation, node.read(id)).pipe(
    Effect.flatMap((content) =>
      content === undefined
        ? Effect.fail(
            new AutomationAuthoringError({
              operation,
              code: "not-found",
              message: `Automation ${id} does not exist`,
            }),
          )
        : Effect.succeed(content),
    ),
  );
}

function requireValidId(
  operation: string,
  id: string,
): Effect.Effect<void, AutomationAuthoringError> {
  return isAutomationId(id)
    ? Effect.void
    : Effect.fail(
        new AutomationAuthoringError({
          operation,
          code: "invalid-definition",
          message: `Invalid Automation id: ${id}`,
        }),
      );
}

function requireRevision(
  operation: string,
  id: string,
  content: Uint8Array,
  expectedRevision: string,
): Effect.Effect<void, AutomationAuthoringError> {
  return revisionOf(content) === expectedRevision
    ? Effect.void
    : Effect.fail(
        new AutomationAuthoringError({
          operation,
          code: "conflict",
          message: `Automation ${id} changed since it was inspected`,
        }),
      );
}

function observe(
  definition: AutomationDefinition,
  content: string,
  bytes: Uint8Array,
): AutomationObservation {
  return { definition, content, revision: revisionOf(bytes) };
}

function revisionOf(content: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function encodeUtf8(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function decodeUtf8(
  operation: string,
  id: string,
  bytes: Uint8Array,
): Effect.Effect<string, AutomationAuthoringError> {
  return Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) =>
      new AutomationAuthoringError({
        operation,
        code: "invalid-definition",
        message: `Automation ${id} is not valid UTF-8`,
        cause,
      }),
  });
}

function mapNodeError<Value>(
  operation: string,
  effect: Effect.Effect<Value, AutomationNodeError>,
): Effect.Effect<Value, AutomationAuthoringError> {
  return effect.pipe(
    Effect.mapError((cause) => {
      if (cause.code === "conflict") {
        return new AutomationAuthoringError({
          operation,
          code: "conflict",
          message: cause.message,
          cause,
        });
      }
      if (cause.code === "not-found") {
        return new AutomationAuthoringError({
          operation,
          code: "not-found",
          message: cause.message,
          cause,
        });
      }
      return new AutomationAuthoringError({
        operation,
        code: "operation-failed",
        message: cause.message,
        cause,
      });
    }),
  );
}
