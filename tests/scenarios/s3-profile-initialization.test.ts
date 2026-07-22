import { afterAll, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import { BunProcessManager } from "../../packages/ziggy/src/bun-process-node-adapter.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";
import {
  initializeProfile as initializeProfileEffect,
  ProfileInitializationError,
  profileConfigText,
  voiceNames,
  voiceTemplates,
  type ProfileInitializationPoint,
  type ProfileInitializationRequest,
  type ProfileInitializationResult,
} from "../../packages/ziggy/src/profile-initialization.ts";
import { runEffect } from "../testkit/effect.ts";

const temporaryPaths: string[] = [];
const processManager = new BunProcessManager();

interface TestProfileInitializationRequest extends Omit<
  ProfileInitializationRequest,
  "onBeforeCreate"
> {
  readonly onBeforeCreate?: (point: ProfileInitializationPoint) => void | Promise<void>;
}

function initializeProfile(
  request: TestProfileInitializationRequest,
): Promise<ProfileInitializationResult> {
  const onBeforeCreate = request.onBeforeCreate;
  return runEffect(
    initializeProfileEffect({
      profilePath: request.profilePath,
      ...(request.voice === undefined ? {} : { voice: request.voice }),
      ...(onBeforeCreate === undefined
        ? {}
        : {
            onBeforeCreate: (point: ProfileInitializationPoint) =>
              Effect.tryPromise({
                try: () => Promise.resolve(onBeforeCreate(point)),
                catch: (cause) =>
                  new ProfileInitializationError({
                    operation: "run test hook",
                    path: request.profilePath,
                    message:
                      cause instanceof Error ? cause.message : "Profile initialization hook failed",
                    cause,
                  }),
              }),
          }),
    }),
  );
}

describe("S3 Profile initialization", () => {
  test("creates the complete private layout with the strict default config", async () => {
    const profile = await temporaryPath("layout");

    const result = await initializeProfile({ profilePath: profile });
    const canonicalProfile = join(await realpath(dirname(profile)), basename(profile));

    expect(result).toEqual({
      schemaVersion: 1,
      profilePath: canonicalProfile,
      voice: "clear",
      created: [
        ".",
        "ziggy.jsonc",
        "automations/",
        "credentials/",
        "extensions/",
        "memory/",
        "sessions/",
        "SOUL.md",
      ],
    });
    expect((await readdir(profile)).sort()).toEqual([
      "SOUL.md",
      "automations",
      "credentials",
      "extensions",
      "memory",
      "sessions",
      "ziggy.jsonc",
    ]);
    expect(await readFile(join(profile, "ziggy.jsonc"), "utf8")).toBe(profileConfigText);
    expect(JSON.parse(profileConfigText)).toEqual({
      schemaVersion: 1,
      defaultProvider: "anthropic",
      defaultModel: "claude-fable-5",
      thinkingLevel: "medium",
      cacheRetention: "long",
    });
    expect(await readFile(join(profile, "SOUL.md"), "utf8")).toBe(voiceTemplates.clear);
    for (const directory of [
      profile,
      join(profile, "memory"),
      join(profile, "sessions"),
      join(profile, "extensions"),
      join(profile, "automations"),
      join(profile, "credentials"),
    ]) {
      expect(await mode(directory)).toBe(0o700);
    }
    expect(await mode(join(profile, "ziggy.jsonc"))).toBe(0o600);
    expect(await mode(join(profile, "SOUL.md"))).toBe(0o600);
    expect(await exists(join(profile, ".runtime"))).toBeFalse();
    expect(await readdir(join(profile, "credentials"))).toEqual([]);
    expect(await readdir(join(profile, "sessions"))).toEqual([]);
    expect(await exists(join(profile, "sessions", "main.ndjson"))).toBeFalse();
  });

  test("embeds three section-distinct Voices and uses clear by default", async () => {
    expect(voiceNames).toEqual(["clear", "warm", "operator"]);
    const sections = ["Persona Summary", "Tone Directives", "Default Verbosity"];
    for (const section of sections) {
      expect(
        new Set(voiceNames.map((voice) => sectionBody(voiceTemplates[voice], section))).size,
      ).toBe(voiceNames.length);
    }

    for (const voice of voiceNames) {
      const profile = await temporaryPath(`voice-${voice}`);
      await initializeProfile({ profilePath: profile, voice });
      expect(await readFile(join(profile, "SOUL.md"), "utf8")).toBe(voiceTemplates[voice]);
    }
  });

  test("reruns preserve edited scaffold entries, arbitrary files, and existing modes byte-for-byte", async () => {
    const profile = await temporaryPath("preserve");
    await mkdir(profile, { mode: 0o755 });
    await writeFile(join(profile, "SOUL.md"), new Uint8Array([0, 1, 2, 255]), { mode: 0o644 });
    await writeFile(join(profile, "notes.txt"), "owner data\n", { mode: 0o640 });
    await chmod(profile, 0o755);
    await chmod(join(profile, "SOUL.md"), 0o644);

    await initializeProfile({ profilePath: profile, voice: "warm" });
    const before = await snapshot(profile);
    const rerun = await initializeProfile({ profilePath: profile, voice: "operator" });

    expect(await snapshot(profile)).toEqual(before);
    expect(Buffer.from(await readFile(join(profile, "SOUL.md")))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(await readFile(join(profile, "notes.txt"), "utf8")).toBe("owner data\n");
    expect(await mode(profile)).toBe(0o755);
    expect(await mode(join(profile, "SOUL.md"))).toBe(0o644);
    expect(rerun.created).toEqual([]);
  });

  test("accepts JSONC comments and preserves existing config bytes and mode", async () => {
    const profile = await temporaryDirectory("commented-config");
    const config = `{
  // Provider IDs remain open to the pi-ai catalog.
  "schemaVersion": 1,
  "defaultProvider": "openai//compatible",
  "defaultModel": "model/*owner-text*/name",
  /* Profile defaults. */
  "thinkingLevel": "medium",
  "cacheRetention": "long"
}\n`;
    const configPath = join(profile, "ziggy.jsonc");
    await writeFile(configPath, config, { mode: 0o640 });
    await chmod(configPath, 0o640);

    await initializeProfile({ profilePath: profile });

    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await mode(configPath)).toBe(0o640);
  });

  test("rejects invalid existing config before any mutation", async () => {
    const cases = [
      ["malformed JSON", "{"],
      ["unterminated block comment", "{/* never closed"],
      [
        "missing field",
        JSON.stringify({
          schemaVersion: 1,
          defaultProvider: "anthropic",
          defaultModel: "claude-fable-5",
          thinkingLevel: "medium",
        }),
      ],
      [
        "unknown field",
        JSON.stringify({
          schemaVersion: 1,
          defaultProvider: "anthropic",
          defaultModel: "claude-fable-5",
          thinkingLevel: "medium",
          cacheRetention: "long",
          extra: true,
        }),
      ],
      [
        "wrong primitive",
        JSON.stringify({
          schemaVersion: 1,
          defaultProvider: 42,
          defaultModel: "claude-fable-5",
          thinkingLevel: "medium",
          cacheRetention: "long",
        }),
      ],
      [
        "empty provider",
        JSON.stringify({
          schemaVersion: 1,
          defaultProvider: "",
          defaultModel: "claude-fable-5",
          thinkingLevel: "medium",
          cacheRetention: "long",
        }),
      ],
      [
        "empty model",
        JSON.stringify({
          schemaVersion: 1,
          defaultProvider: "anthropic",
          defaultModel: "",
          thinkingLevel: "medium",
          cacheRetention: "long",
        }),
      ],
      [
        "invalid thinking level",
        JSON.stringify({
          schemaVersion: 1,
          defaultProvider: "anthropic",
          defaultModel: "claude-fable-5",
          thinkingLevel: "extreme",
          cacheRetention: "long",
        }),
      ],
      [
        "invalid cache retention",
        JSON.stringify({
          schemaVersion: 1,
          defaultProvider: "anthropic",
          defaultModel: "claude-fable-5",
          thinkingLevel: "medium",
          cacheRetention: "forever",
        }),
      ],
      [
        "unsupported schema version",
        JSON.stringify({
          schemaVersion: 2,
          defaultProvider: "anthropic",
          defaultModel: "claude-fable-5",
          thinkingLevel: "medium",
          cacheRetention: "long",
        }),
      ],
    ] satisfies ReadonlyArray<readonly [string, string]>;

    for (const [label, config] of cases) {
      const profile = await temporaryDirectory(`invalid-config-${label.replaceAll(" ", "-")}`);
      const configPath = join(profile, "ziggy.jsonc");
      const createPoints: ProfileInitializationPoint[] = [];
      await writeFile(configPath, config);

      await expect(
        initializeProfile({
          profilePath: profile,
          onBeforeCreate: (point) => {
            createPoints.push(point);
          },
        }),
      ).rejects.toThrow();

      expect(createPoints, label).toEqual([]);
      expect(await readdir(profile), label).toEqual(["ziggy.jsonc"]);
      expect(await readFile(configPath, "utf8"), label).toBe(config);
    }
  });

  test("rejects an unknown Voice before creating the Profile", async () => {
    const profile = await temporaryPath("unknown-voice");

    await expect(initializeProfile({ profilePath: profile, voice: "loud" })).rejects.toThrow(
      "unknown Voice",
    );
    expect(await exists(profile)).toBeFalse();
  });

  test("rejects symbolic links and wrong-kind scaffold paths before adding entries", async () => {
    const outside = await temporaryDirectory("outside");
    const linkedProfile = await temporaryPath("linked-root");
    await symlink(outside, linkedProfile, "dir");
    await expect(initializeProfile({ profilePath: linkedProfile })).rejects.toThrow(
      "symbolic link",
    );

    const fileProfile = await temporaryPath("file-root");
    await writeFile(fileProfile, "not a Profile directory");
    await expect(initializeProfile({ profilePath: fileProfile })).rejects.toThrow(
      "expected directory",
    );

    for (const [name, prepare] of [
      ["SOUL.md", (profile: string) => mkdir(join(profile, "SOUL.md"))],
      ["memory", (profile: string) => writeFile(join(profile, "memory"), "wrong kind")],
      [
        "ziggy.jsonc",
        (profile: string) => symlink(join(outside, "missing"), join(profile, "ziggy.jsonc")),
      ],
      ["sessions", (profile: string) => symlink(outside, join(profile, "sessions"), "dir")],
    ] satisfies ReadonlyArray<readonly [string, (profile: string) => Promise<unknown>]>) {
      const profile = await temporaryDirectory(`conflict-${name.replaceAll(".", "-")}`);
      await prepare(profile);
      await expect(initializeProfile({ profilePath: profile })).rejects.toThrow();
      expect(await exists(join(profile, "automations"))).toBeFalse();
    }
  });

  test("same-process concurrent initializers converge through exclusive creation without clobbering", async () => {
    const profile = await temporaryPath("concurrent");

    await Promise.all(
      Array.from({ length: 12 }, () => initializeProfile({ profilePath: profile, voice: "clear" })),
    );

    expect(await readFile(join(profile, "SOUL.md"), "utf8")).toBe(voiceTemplates.clear);
    expect(await readFile(join(profile, "ziggy.jsonc"), "utf8")).toBe(profileConfigText);
    expect(await readdir(profile)).toHaveLength(7);
  });

  test("rejects an invalid config won by a child process before adding scaffold entries", async () => {
    const profile = await temporaryPath("config-race");
    let childRan = false;

    await expect(
      initializeProfile({
        profilePath: profile,
        onBeforeCreate: async (point) => {
          if (point !== "ziggy.jsonc" || childRan) return;
          childRan = true;
          const configPath = join(profile, "ziggy.jsonc");
          const child = Bun.spawn(
            [
              "bun",
              "-e",
              'const path = process.env.ZIGGY_TEST_CONFIG_PATH; if (!path) throw new Error("missing path"); await Bun.write(path, "{");',
            ],
            {
              env: { ...process.env, ZIGGY_TEST_CONFIG_PATH: configPath },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const [exitCode, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          expect(exitCode, stderr).toBe(0);
        },
      }),
    ).rejects.toThrow("invalid Profile config");

    expect(childRan).toBeTrue();
    expect(await readdir(profile)).toEqual(["ziggy.jsonc"]);
    expect(await readFile(join(profile, "ziggy.jsonc"), "utf8")).toBe("{");
  });

  test("an injected pre-create failure fails loud and permits retry", async () => {
    const profile = await temporaryPath("fault");
    let armed = true;
    const onBeforeCreate = (point: ProfileInitializationPoint): void => {
      if (armed && point === "SOUL.md") {
        armed = false;
        const error = new Error("injected permission denial");
        Object.defineProperty(error, "code", { value: "EACCES" });
        throw error;
      }
    };

    await expect(initializeProfile({ profilePath: profile, onBeforeCreate })).rejects.toThrow(
      "permission denial",
    );
    expect(await exists(join(profile, "SOUL.md"))).toBeFalse();
    await initializeProfile({ profilePath: profile });
    expect(await readFile(join(profile, "SOUL.md"), "utf8")).toBe(voiceTemplates.clear);
  });

  test("canonicalizes an existing final-component alias when the host exposes one", async () => {
    const root = await temporaryDirectory("final-alias");
    const canonicalProfile = join(root, "Profile");
    const requestedProfile = join(root, "profile");
    await mkdir(canonicalProfile);
    if (!(await exists(requestedProfile))) return;

    const result = await initializeProfile({ profilePath: requestedProfile });

    expect(result.profilePath).toBe(await realpath(canonicalProfile));
  });

  test("canonicalizes Profile identity through ancestor aliases for creation and reruns", async () => {
    const root = await temporaryDirectory("ancestor-alias");
    const realRoot = join(root, "real");
    const realParent = join(realRoot, "parent");
    const alias = join(root, "alias");
    await mkdir(realParent, { recursive: true });
    await symlink(realRoot, alias, "dir");
    const requestedProfile = join(alias, "parent", "profile");
    const canonicalProfile = join(await realpath(realParent), "profile");

    const created = await initializeProfile({ profilePath: requestedProfile });

    expect(created.profilePath).toBe(canonicalProfile);
    expect(await realpath(created.profilePath)).toBe(canonicalProfile);
    expect(await readFile(join(canonicalProfile, "SOUL.md"), "utf8")).toBe(voiceTemplates.clear);
    await writeFile(join(canonicalProfile, "notes.txt"), "owner data\n", { mode: 0o640 });
    const before = await snapshot(canonicalProfile);

    const rerun = await initializeProfile({ profilePath: requestedProfile, voice: "warm" });

    expect(rerun.profilePath).toBe(canonicalProfile);
    expect(rerun.created).toEqual([]);
    expect(await snapshot(canonicalProfile)).toEqual(before);
  });

  test("rejects broken ancestor aliases and missing parents before mutation", async () => {
    const root = await temporaryDirectory("broken-ancestor");
    const missingTarget = join(root, "missing-target");
    const alias = join(root, "alias");
    await symlink(missingTarget, alias, "dir");

    await expect(initializeProfile({ profilePath: join(alias, "profile") })).rejects.toThrow(
      "Profile parent directory does not exist",
    );
    await expect(
      initializeProfile({ profilePath: join(root, "missing-parent", "profile") }),
    ).rejects.toThrow("Profile parent directory does not exist");
    expect(await exists(missingTarget)).toBeFalse();
    expect(await exists(join(root, "missing-parent"))).toBeFalse();
  });

  test("the standalone executable carries Voice content without runtime source lookup", async () => {
    const directory = await temporaryDirectory("compiled");
    const executable = join(directory, "ziggy");
    const profile = join(directory, "profile");
    const build = await runEffect(
      processManager.run(
        ["bun", "build", "--compile", "packages/ziggy/src/main.ts", "--outfile", executable],
        120_000,
      ),
    );
    expect(build.exitCode, build.stderr).toBe(0);

    const run = await runEffect(
      processManager.run([executable, "init", profile, "--voice", "operator"], 10_000),
    );
    expect(run.exitCode, run.stderr).toBe(0);
    expect(await readFile(join(profile, "SOUL.md"), "utf8")).toBe(voiceTemplates.operator);
  });
});

afterAll(async () => {
  emitVerificationObservation("s3.profile-initialization", emptyRuntimeObservations());
  await Promise.all(temporaryPaths.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryPath(label: string): Promise<string> {
  const parent = await temporaryDirectory(`${label}-parent`);
  return join(parent, "profile");
}

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `ziggy-s3-${label}-`));
  temporaryPaths.push(path);
  return path;
}

async function mode(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function sectionBody(contents: string, heading: string): string {
  const marker = `## ${heading}\n`;
  const start = contents.indexOf(marker);
  if (start < 0) throw new Error(`missing ${heading}`);
  const bodyStart = start + marker.length;
  const nextHeading = contents.indexOf("\n## ", bodyStart);
  return contents.slice(bodyStart, nextHeading < 0 ? undefined : nextHeading).trim();
}

async function snapshot(profile: string): Promise<Readonly<Record<string, string>>> {
  const entries = await readdir(profile, { withFileTypes: true });
  const values: Record<string, string> = {};
  for (const entry of entries) {
    const path = join(profile, entry.name);
    values[entry.name] = entry.isDirectory()
      ? `dir:${await mode(path)}`
      : `file:${await mode(path)}:${Buffer.from(await readFile(path)).toString("base64")}`;
  }
  return values;
}
