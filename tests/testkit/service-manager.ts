import type {
  CommandResult,
  DefinitionExpectation,
  DefinitionState,
  ProcessManager,
  ServiceFilesystem,
  ServiceError,
} from "../../packages/ziggy/src/service.ts";
import {
  classifyServiceDefinition,
  ServiceError as ServiceFailure,
} from "../../packages/ziggy/src/service.ts";
import { Effect } from "effect";

export class MemoryServiceFilesystem implements ServiceFilesystem {
  readonly files = new Map<string, string>();
  readonly mutations: Array<string> = [];
  readonly canonical = new Map<string, string>();
  canonicalize(path: string): Effect.Effect<string, ServiceError> {
    return Effect.succeed(this.canonical.get(path) ?? path);
  }
  classify(
    path: string,
    expected: DefinitionExpectation,
  ): Effect.Effect<DefinitionState, ServiceError> {
    const content = this.files.get(path);
    if (content === undefined) return Effect.succeed("absent");
    return Effect.succeed(classifyServiceDefinition(content, expected));
  }
  create(path: string, content: string): Effect.Effect<void, ServiceError> {
    if (this.files.has(path))
      return Effect.fail(serviceFailure("create", `service definition exists: ${path}`));
    this.mutations.push(`create:${path}`);
    this.files.set(path, content);
    return Effect.void;
  }
  replace(
    path: string,
    content: string,
    expected: DefinitionExpectation,
  ): Effect.Effect<void, ServiceError> {
    const state = this.files.has(path)
      ? classifyServiceDefinition(this.files.get(path) ?? "", expected)
      : "absent";
    if (state !== "current" && state !== "owned-drifted")
      return Effect.fail(
        serviceFailure("replace", `service definition changed before mutation: ${state}`),
      );
    this.mutations.push(`replace:${path}`);
    this.files.set(path, content);
    return Effect.void;
  }
  remove(path: string, expected: DefinitionExpectation): Effect.Effect<void, ServiceError> {
    const state = this.files.has(path)
      ? classifyServiceDefinition(this.files.get(path) ?? "", expected)
      : "absent";
    if (state !== "current" && state !== "owned-drifted")
      return Effect.fail(
        serviceFailure("remove", `service definition changed before mutation: ${state}`),
      );
    this.mutations.push(`remove:${path}`);
    this.files.delete(path);
    return Effect.void;
  }
}

export class ScriptedProcess implements ProcessManager {
  readonly calls: Array<ReadonlyArray<string>> = [];
  readonly timeouts: Array<number> = [];
  private readonly queued: Array<{
    readonly argv: ReadonlyArray<string>;
    readonly response: CommandResult | Error;
  }> = [];
  expect(argv: ReadonlyArray<string>, response: CommandResult | Error = ok()): void {
    this.queued.push({ argv: [...argv], response });
  }
  verifyComplete(): void {
    if (this.queued.length !== 0)
      throw new Error(`unconsumed process expectations: ${this.queued.length}`);
  }
  run(argv: ReadonlyArray<string>, timeoutMs: number): Effect.Effect<CommandResult, ServiceError> {
    this.calls.push([...argv]);
    this.timeouts.push(timeoutMs);
    const expected = this.queued.shift();
    if (expected === undefined)
      return Effect.fail(
        serviceFailure("run", `unexpected process command: ${JSON.stringify(argv)}`),
      );
    if (!sameArgv(argv, expected.argv))
      return Effect.fail(
        serviceFailure(
          "run",
          `unexpected process command: ${JSON.stringify(argv)}; expected ${JSON.stringify(expected.argv)}`,
        ),
      );
    const response = expected.response;
    if (response instanceof Error) {
      return Effect.fail(serviceFailure("run", response.message, response));
    }
    return Effect.succeed(response);
  }
}
export const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
export const missing = (): CommandResult => ({ exitCode: 3, stdout: "", stderr: "not found" });
function sameArgv(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function serviceFailure(operation: string, message: string, cause?: unknown): ServiceError {
  return new ServiceFailure({ operation, message, ...(cause === undefined ? {} : { cause }) });
}
