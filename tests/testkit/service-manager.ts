import type {
  CommandResult,
  DefinitionExpectation,
  DefinitionState,
  ProcessManager,
  ServiceFilesystem,
} from "../../packages/ziggy/src/service.ts";
import { classifyServiceDefinition } from "../../packages/ziggy/src/service.ts";

export class MemoryServiceFilesystem implements ServiceFilesystem {
  readonly files = new Map<string, string>();
  readonly mutations: Array<string> = [];
  readonly canonical = new Map<string, string>();
  canonicalize(path: string): Promise<string> {
    return Promise.resolve(this.canonical.get(path) ?? path);
  }
  classify(path: string, expected: DefinitionExpectation): Promise<DefinitionState> {
    const content = this.files.get(path);
    if (content === undefined) return Promise.resolve("absent");
    return Promise.resolve(classifyServiceDefinition(content, expected));
  }
  create(path: string, content: string): Promise<void> {
    if (this.files.has(path))
      return Promise.reject(new Error(`service definition exists: ${path}`));
    this.mutations.push(`create:${path}`);
    this.files.set(path, content);
    return Promise.resolve();
  }
  replace(path: string, content: string, expected: DefinitionExpectation): Promise<void> {
    const state = this.files.has(path)
      ? classifyServiceDefinition(this.files.get(path) ?? "", expected)
      : "absent";
    if (state !== "current" && state !== "owned-drifted")
      return Promise.reject(new Error(`service definition changed before mutation: ${state}`));
    this.mutations.push(`replace:${path}`);
    this.files.set(path, content);
    return Promise.resolve();
  }
  remove(path: string, expected: DefinitionExpectation): Promise<void> {
    const state = this.files.has(path)
      ? classifyServiceDefinition(this.files.get(path) ?? "", expected)
      : "absent";
    if (state !== "current" && state !== "owned-drifted")
      return Promise.reject(new Error(`service definition changed before mutation: ${state}`));
    this.mutations.push(`remove:${path}`);
    this.files.delete(path);
    return Promise.resolve();
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
  run(argv: ReadonlyArray<string>, timeoutMs: number): Promise<CommandResult> {
    this.calls.push([...argv]);
    this.timeouts.push(timeoutMs);
    const expected = this.queued.shift();
    if (expected === undefined)
      return Promise.reject(new Error(`unexpected process command: ${JSON.stringify(argv)}`));
    if (!sameArgv(argv, expected.argv))
      return Promise.reject(
        new Error(
          `unexpected process command: ${JSON.stringify(argv)}; expected ${JSON.stringify(expected.argv)}`,
        ),
      );
    const response = expected.response;
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  }
}
export const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
export const missing = (): CommandResult => ({ exitCode: 3, stdout: "", stderr: "not found" });
function sameArgv(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}
