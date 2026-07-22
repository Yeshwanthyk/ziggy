import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ExtensionApprovalRequirement,
  type ExtensionInstallResult,
  ExtensionLifecycle,
  type ExtensionLifecycleOptions,
  type ExtensionLifecycleService,
} from "../../packages/core/src/index.ts";
import type { ExtensionLifecycleNodeCheckpoint } from "../../packages/core/src/extensions/lifecycle-node-adapter.ts";
import { Effect } from "effect";
import { runEffect } from "./effect.ts";

export interface S4ExtensionFixtureOptions {
  readonly skills?: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  readonly tools?: ReadonlyArray<{ readonly id: string; readonly path: string }>;
  readonly setup?: {
    readonly steps: ReadonlyArray<{ readonly argv: ReadonlyArray<string> }>;
    readonly doctor?: { readonly argv: ReadonlyArray<string> };
  };
  readonly files?: Readonly<Record<string, string>>;
  readonly version?: string;
  readonly requiresEnv?: ReadonlyArray<string>;
  readonly requiresCommands?: ReadonlyArray<string>;
  readonly secrets?: ReadonlyArray<string>;
  readonly filesystemPermission?: "none" | "profile" | "full";
}

export interface S4ExtensionFixture {
  readonly root: string;
  readonly profile: string;
  readonly source: string;
}

export async function createS4ExtensionFixture(
  name: string,
  options: S4ExtensionFixtureOptions = {},
): Promise<S4ExtensionFixture> {
  const root = await mkdtemp(join(tmpdir(), `ziggy-s4-scenario-${name}-`));
  const profile = join(root, "profile");
  const source = join(root, "source");
  await mkdir(profile);
  await mkdir(source);
  const skills = options.skills ?? [{ id: "fixture", path: "skills/fixture" }];
  const manifest = {
    schemaVersion: 1,
    id: "fixture",
    version: options.version ?? "1.0.0",
    name: "Fixture",
    description: "Deterministic S4 scenario fixture.",
    ziggy: { requires: ">=0.0.0 <=9.0.0" },
    skills,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    adapters: [],
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    requires: {
      env: options.requiresEnv ?? [],
      commands: options.requiresCommands ?? [],
      os: [],
    },
    permissions: {
      network: false,
      filesystem: options.filesystemPermission ?? "none",
      secrets: options.secrets ?? [],
    },
    distribution: { source: "fixture", license: "MIT" },
  };
  await writeFixtureFile(source, "extension.json", `${JSON.stringify(manifest, undefined, 2)}\n`);
  if (skills.length > 0) {
    await writeFixtureFile(
      source,
      "skills/fixture/SKILL.md",
      "---\nname: fixture\ndescription: S4 scenario Skill\n---\n\nFixture.\n",
    );
  }
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    await writeFixtureFile(source, path, contents);
  }
  return { root, profile, source };
}

export function useS4Lifecycle<Value>(
  profilePath: string,
  use: (service: ExtensionLifecycleService) => Effect.Effect<Value, unknown>,
  overrides: Omit<ExtensionLifecycleOptions, "profilePath"> = {},
): Promise<Value> {
  return runEffect(
    Effect.gen(function* () {
      const service = yield* ExtensionLifecycle;
      return yield* use(service);
    }).pipe(Effect.provide(ExtensionLifecycle.layer({ profilePath, ...overrides }))),
  );
}

export function installS4Fixture(
  profilePath: string,
  sourcePath: string,
  approvals: ReadonlyArray<string>,
  overrides: Omit<ExtensionLifecycleOptions, "profilePath"> = {},
): Promise<ExtensionInstallResult> {
  return useS4Lifecycle(
    profilePath,
    (service) => service.install({ sourcePath, approvals }),
    overrides,
  );
}

export function requireApprovalRequirements(
  result: ExtensionInstallResult,
): ReadonlyArray<ExtensionApprovalRequirement> {
  if (result.status === "approval-required") return result.requirements;
  throw new Error("Expected exact Extension approval requirements");
}

export async function crashS4Install(
  profilePath: string,
  sourcePath: string,
  checkpoint: ExtensionLifecycleNodeCheckpoint,
): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "fixtures", "extension-lifecycle-crash-child.ts"),
    ],
    {
      cwd: join(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        ZIGGY_CRASH_PROFILE: profilePath,
        ZIGGY_CRASH_SOURCE: sourcePath,
        ZIGGY_CRASH_CHECKPOINT: checkpoint,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    await Promise.race([
      readUntilReady(child.stdout),
      Bun.sleep(5_000).then(() => Promise.reject(new Error(`child missed ${checkpoint}`))),
    ]);
  } catch (cause) {
    child.kill(9);
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Crash child failed at ${checkpoint}: ${stderr}`, { cause });
  }
  child.kill(9);
  await child.exited;
}

export async function recoveredS4Version(profilePath: string): Promise<string | undefined> {
  const observations = await useS4Lifecycle(profilePath, (service) => service.list());
  return observations[0]?.version;
}

export async function s4TransactionArtifacts(profilePath: string): Promise<ReadonlyArray<string>> {
  const authorityRoot = join(profilePath, ".runtime", "extensions");
  if (!(await Bun.file(authorityRoot).exists())) return [];
  const entries: string[] = [];
  for await (const path of new Bun.Glob(
    "{.transactions/**,.quarantine-*,**/*.tmp,**/*.restore}",
  ).scan({ cwd: authorityRoot, onlyFiles: false })) {
    entries.push(path);
  }
  return entries.sort();
}

export async function mutableStateIdentity(
  profilePath: string,
): Promise<{ readonly contents: string; readonly inode: number }> {
  const path = join(profilePath, ".runtime", "extensions", "fixture", "state", "owner.json");
  return { contents: await readFile(path, "utf8"), inode: (await stat(path)).ino };
}

export async function writeFixtureFile(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents, { mode: 0o700 });
}

async function readUntilReady(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  let output = "";
  while (!output.includes("READY\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("Crash child exited before READY");
    output += new TextDecoder().decode(next.value);
  }
}
