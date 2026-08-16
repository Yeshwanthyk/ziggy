/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures own temporary filesystem setup */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Effect } from "effect";
import {
  automationFileStore,
  installAutomationDefinition,
  pauseAutomationDefinition,
  removeAutomationDefinition,
  resumeAutomationDefinition,
} from "ziggy/adapters/fs/automation-files";
import type { ExtensionArchiveClientApi } from "ziggy/adapters/github/extension-catalog";
import { makeProfileExtensionMutationLock } from "ziggy/adapters/bun/profile-extension-lock";
import {
  extensionSelectionGeneration,
  snapshotExtensionSelection,
} from "ziggy/adapters/fs/profile-extensions";
import { discoverPiResources } from "ziggy/adapters/pi/resources";
import { makeProfileExtensionPreflight } from "ziggy/adapters/pi/profile-extension-preflight";
import { openChat } from "ziggy/adapters/pi/pi-agent";
import {
  makeProfileExtensions,
  type ProfileExtensionAutomationOperations,
} from "ziggy/application/profile-extensions";
import { AutomationFileSystemError } from "ziggy/domain/automation";
import { ExtensionCatalogUnavailable } from "ziggy/domain/extension-catalog";
import {
  ProfileExtensionPreflightFailed,
  ProfileExtensionRollbackFailed,
} from "ziggy/domain/profile-extension";
import type {
  ProfileExtensionMutationLockApi,
  ProfileExtensionPreflightApi,
  ProfileExtensionsApi,
} from "ziggy/domain/profile-extension";

const roots: string[] = [];
const preflightCounts = {
  extensionPathCount: 0,
  skillPathCount: 0,
  extensionFactoryCount: 0,
};

const noDownload: ExtensionArchiveClientApi = {
  download: () =>
    Effect.fail(
      new ExtensionCatalogUnavailable({
        operation: "test download",
        message: "bundled catalogue entry must not use the network",
        cause: undefined,
      }),
    ),
};

const noPreflight: ProfileExtensionPreflightApi = {
  preflight: () => Effect.succeed(preflightCounts),
};

const noLock: ProfileExtensionMutationLockApi = {
  withLock: <A, E, R>(_profilePath: string, use: Effect.Effect<A, E, R>) => use,
};

const makeProfile = async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-profile-extensions-"));
  roots.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath, { recursive: true });
  await writeFile(join(profilePath, "SOUL.md"), "# Test profile\n");
  return {
    root,
    profilePath,
    repositoryRoot: join(root, "repository"),
    target: { path: profilePath, name: "Test" },
  };
};

const writeSelection = async (profilePath: string, ids: ReadonlyArray<string>): Promise<string> => {
  const bytes = `${JSON.stringify({ extensions: [...ids].sort() }, null, 2)}\n`;
  await writeFile(join(profilePath, "extensions.json"), bytes);
  return bytes;
};

const profileTree = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = join(directory, entry.name);
      const name = relative(root, absolute);
      if (entry.isDirectory()) {
        entries.push(`${name}/`);
        await visit(absolute);
      } else {
        entries.push(`${name}:${Buffer.from(await readFile(absolute)).toString("base64")}`);
      }
    }
  };
  await visit(root);
  return entries;
};

const writeShelfPackage = async (
  profilePath: string,
  id: string,
  options: {
    readonly code?: boolean;
    readonly skill?: boolean;
    readonly automation?: { readonly id: string; readonly path: string };
  } = { skill: true },
  packageName = `@ziggy/${id}`,
): Promise<string> => {
  const packagePath = join(profilePath, "extensions", id);
  await mkdir(packagePath, { recursive: true });
  const extensions: string[] = [];
  const skills: string[] = [];
  if (options.skill === true) {
    skills.push("./skills");
    await mkdir(join(packagePath, "skills", id), { recursive: true });
    await writeFile(
      join(packagePath, "skills", id, "SKILL.md"),
      `---\nname: ${id}\ndescription: ${id} test skill\n---\n\n# ${id}\n`,
    );
  }
  if (options.code === true) {
    extensions.push("./index.ts");
    await writeFile(join(packagePath, "index.ts"), "export default function () {}\n");
  }
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        description: `${id} test package`,
        pi: { extensions, skills },
        ziggy: { automations: options.automation === undefined ? [] : [options.automation] },
      },
      null,
      2,
    )}\n`,
  );
  return packagePath;
};

const automationSource = (owner: string): string =>
  `---\nversion: 1\nowner: ${owner}\ncron: 0 3 * * *\ntimezone: UTC\nbroadcast: none\n---\n\nRun the test automation.\n`;

const writeAutomationPackage = async (
  profilePath: string,
  id: string,
  automationId: string,
): Promise<string> => {
  const packagePath = await writeShelfPackage(profilePath, id, {
    skill: true,
    automation: { id: automationId, path: `./automations/${automationId}.md` },
  });
  const automationPath = join(packagePath, "automations", `${automationId}.md`);
  await mkdir(join(packagePath, "automations"), { recursive: true });
  await writeFile(automationPath, automationSource(`extension:${id}`));
  return packagePath;
};

const makeAutomationOperations = (
  failInstallForBeta: boolean,
  failRemoveForAlpha: boolean,
): ProfileExtensionAutomationOperations => ({
  files: automationFileStore,
  install: (target, id, source) =>
    failInstallForBeta && id === "beta-job"
      ? Effect.fail(
          new AutomationFileSystemError({
            path: join(target.path, "automations", `${id}.md`),
            message: "injected beta activation failure",
            cause: "injected",
          }),
        )
      : installAutomationDefinition(target, id, source),
  remove: (target, id, source) =>
    failRemoveForAlpha && id === "alpha-job"
      ? Effect.fail(
          new AutomationFileSystemError({
            path: join(target.path, "automations", `${id}.md`),
            message: "injected alpha rollback failure",
            cause: "injected",
          }),
        )
      : removeAutomationDefinition(target, id, source),
  pause: pauseAutomationDefinition,
  resume: resumeAutomationDefinition,
});

const makeService = (
  preflight: ProfileExtensionPreflightApi = noPreflight,
  lock: ProfileExtensionMutationLockApi = noLock,
  automation?: ProfileExtensionAutomationOperations,
): ProfileExtensionsApi =>
  makeProfileExtensions(noDownload, preflight, lock, undefined, undefined, automation);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("lists catalog metadata and Profile-owned shelf choices through one service", async () => {
  const fixture = await makeProfile();
  const service = makeService();

  const listed = await Effect.runPromise(service.list(fixture.repositoryRoot));
  expect(listed.find((entry) => entry.id === "weather")).toMatchObject({
    id: "weather",
    source: "bundled",
    installed: true,
    required: false,
  });
  expect(listed.some((entry) => entry.id === "stray")).toBe(false);

  await writeShelfPackage(fixture.profilePath, "local");
  await writeSelection(fixture.profilePath, []);
  const profileListing = await Effect.runPromise(
    service.listForProfile(fixture.profilePath, fixture.repositoryRoot),
  );
  expect(profileListing.available).toContainEqual({
    id: "local",
    description: "local test package",
    kind: "skill",
    source: "profile",
  });
  expect(profileListing.selected).toEqual([]);
});

test("invalid manifests preserve exact selection bytes and remain inactive", async () => {
  const fixture = await makeProfile();
  const service = makeService();
  const bytes = await writeSelection(fixture.profilePath, []);
  const packagePath = join(fixture.profilePath, "extensions", "broken-manifest");
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, "package.json"), "{\n");

  const result = await Effect.runPromise(
    service.add(fixture.target, fixture.repositoryRoot, "broken-manifest").pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ExtensionCatalogInstallFailed" },
  });
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(bytes);
  expect(
    (await Effect.runPromise(discoverPiResources(fixture.profilePath, fixture.repositoryRoot)))
      .extensionPaths,
  ).toEqual([]);
});

test("automation conflicts preserve selection and human-owned bytes", async () => {
  const fixture = await makeProfile();
  const service = makeService();
  const bytes = await writeSelection(fixture.profilePath, []);
  const automationPath = join(fixture.profilePath, "automations", "self-improvement-curator.md");
  await mkdir(join(fixture.profilePath, "automations"), { recursive: true });
  const bundledAutomation = await readFile(
    join(import.meta.dir, "../../extensions/self-improvement/automations/curator.md"),
    "utf8",
  );
  const humanBytes = bundledAutomation.replace("owner: extension:self-improvement", "owner: human");
  await writeFile(automationPath, humanBytes);

  const result = await Effect.runPromise(
    service.add(fixture.target, fixture.repositoryRoot, "self-improvement").pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ExtensionCatalogInstallFailed" },
  });
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(bytes);
  expect(await readFile(automationPath, "utf8")).toBe(humanBytes);
  expect(existsSync(join(fixture.profilePath, "extensions", "self-improvement"))).toBe(true);
  expect(
    existsSync(join(fixture.profilePath, "automations", "self-improvement-curator.paused.md")),
  ).toBe(false);
  expect(
    (await Effect.runPromise(discoverPiResources(fixture.profilePath, fixture.repositoryRoot)))
      .extensionPaths,
  ).toEqual([]);
});

test("bundled and existing shelf adds select atomically; repeated add is a strict no-op", async () => {
  const fixture = await makeProfile();
  let preflightCalls = 0;
  const service = makeService({
    preflight: () =>
      Effect.sync(() => {
        preflightCalls += 1;
        return preflightCounts;
      }),
  });
  await writeShelfPackage(fixture.profilePath, "local");
  await writeSelection(fixture.profilePath, []);

  expect(
    await Effect.runPromise(service.add(fixture.target, fixture.repositoryRoot, "local")),
  ).toMatchObject({ id: "local", changed: true, selected: true });
  expect(
    await Effect.runPromise(service.add(fixture.target, fixture.repositoryRoot, "weather")),
  ).toMatchObject({ id: "weather", changed: true, selected: true });
  const selectionBytes = await readFile(join(fixture.profilePath, "extensions.json"), "utf8");
  expect(selectionBytes).toBe('{\n  "extensions": [\n    "local",\n    "weather"\n  ]\n}\n');
  const callsBeforeNoOp = preflightCalls;
  expect(
    await Effect.runPromise(service.add(fixture.target, fixture.repositoryRoot, "weather")),
  ).toEqual({
    id: "weather",
    profilePath: fixture.profilePath,
    changed: false,
    selected: true,
  });
  expect(preflightCalls).toBe(callsBeforeNoOp);
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(selectionBytes);
});

test("owned automation is inactive during preflight, activates after selection, and removal pauses it", async () => {
  let activeDuringPreflight = true;
  const preflight: ProfileExtensionPreflightApi = {
    preflight: (profilePath) =>
      Effect.sync(() => {
        activeDuringPreflight = existsSync(
          join(profilePath, "automations", "self-improvement-curator.md"),
        );
        return preflightCounts;
      }),
  };
  const fixture = await makeProfile();
  const service = makeService(preflight);
  await writeSelection(fixture.profilePath, []);

  await Effect.runPromise(service.add(fixture.target, fixture.repositoryRoot, "self-improvement"));
  expect(activeDuringPreflight).toBe(false);
  const activePath = join(fixture.profilePath, "automations", "self-improvement-curator.md");
  const pausedPath = join(fixture.profilePath, "automations", "self-improvement-curator.paused.md");
  expect(existsSync(activePath)).toBe(true);

  const activeBytes = await readFile(activePath, "utf8");
  await Effect.runPromise(
    service.remove(fixture.target, fixture.repositoryRoot, "self-improvement"),
  );
  expect(await readFile(pausedPath, "utf8")).toBe(activeBytes);
  expect(existsSync(activePath)).toBe(false);
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(
    '{\n  "extensions": []\n}\n',
  );

  const noOp = await Effect.runPromise(
    service.remove(fixture.target, fixture.repositoryRoot, "self-improvement"),
  );
  expect(noOp).toEqual({
    id: "self-improvement",
    profilePath: fixture.profilePath,
    changed: false,
    selected: false,
  });
  expect(await readFile(pausedPath, "utf8")).toBe(activeBytes);
});

test("remove rejects a malformed absent ID before returning a no-op", async () => {
  const fixture = await makeProfile();
  const bytes = Buffer.from('{ "extensions" : [ ] }\r\n');
  await writeFile(join(fixture.profilePath, "extensions.json"), bytes);

  const result = await Effect.runPromise(
    makeService()
      .remove(fixture.target, fixture.repositoryRoot, "not_an_extension")
      .pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProfileExtensionInvalid",
      path: join(fixture.profilePath, "extensions.json"),
      message: "invalid extension selection",
    },
  });
  expect(await readFile(join(fixture.profilePath, "extensions.json"))).toEqual(bytes);
});
test("remove valid unselected ID is a byte-preserving no-op", async () => {
  const fixture = await makeProfile();
  await writeAutomationPackage(fixture.profilePath, "unselected", "unselected-job");
  const bytes = Buffer.from('{ "extensions" : [ ] }\r\n');
  await writeFile(join(fixture.profilePath, "extensions.json"), bytes);
  const directory = join(fixture.profilePath, "automations");
  const activePath = join(directory, "unselected-job.md");
  const pausedPath = join(directory, "unselected-job.paused.md");
  await mkdir(directory, { recursive: true });
  const source = automationSource("extension:unselected");
  await writeFile(activePath, source);

  const result = await Effect.runPromise(
    makeService().remove(fixture.target, fixture.repositoryRoot, "unselected"),
  );

  expect(result).toEqual({
    id: "unselected",
    profilePath: fixture.profilePath,
    changed: false,
    selected: false,
  });
  expect(await readFile(activePath, "utf8")).toBe(source);
  expect(existsSync(pausedPath)).toBe(false);
  expect(await readFile(join(fixture.profilePath, "extensions.json"))).toEqual(bytes);
});

test("Pi factory failures are typed, preserve selection bytes, and leave the package inactive", async () => {
  const fixture = await makeProfile();
  const packagePath = await writeShelfPackage(fixture.profilePath, "broken-import", {
    code: true,
    skill: false,
  });
  await writeFile(join(packagePath, "index.ts"), 'throw new Error("factory exploded");\n');
  const bytes = await writeSelection(fixture.profilePath, []);
  const service = makeService(makeProfileExtensionPreflight());

  const result = await Effect.runPromise(
    service.add(fixture.target, fixture.repositoryRoot, "broken-import").pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProfileExtensionPreflightFailed", stage: "extensions" },
  });
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(bytes);
  expect(existsSync(join(fixture.profilePath, "extensions", "broken-import"))).toBe(true);
  expect(
    (await Effect.runPromise(discoverPiResources(fixture.profilePath, fixture.repositoryRoot)))
      .extensionPaths,
  ).toEqual([]);
});

test("actual Pi diagnostics fail before runtime automation activation", async () => {
  const fixture = await makeProfile();
  const packagePath = join(fixture.profilePath, "extensions", "diagnostic-runtime");
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify({
      name: "@upstream/diagnostic-runtime",
      description: "diagnostic runtime package",
      pi: { skills: ["./notes.txt"] },
    })}\n`,
  );
  await writeFile(join(packagePath, "notes.txt"), "not a Pi Markdown skill\n");
  await writeSelection(fixture.profilePath, ["diagnostic-runtime"]);
  const snapshot = await Effect.runPromise(snapshotExtensionSelection(fixture.profilePath));
  let activationCalls = 0;
  const service: ProfileExtensionsApi = {
    ...makeService(noPreflight, noLock),
    prepareRuntime: () =>
      Effect.succeed({
        selected: snapshot.selected,
        generation: extensionSelectionGeneration(snapshot),
      }),
    activateRuntime: () =>
      Effect.sync(() => {
        activationCalls += 1;
      }),
  };

  const result = await Effect.runPromise(
    openChat(
      fixture.target,
      { kind: "local" },
      join(fixture.profilePath, "sessions"),
      fixture.repositoryRoot,
      "fresh",
      undefined,
      service,
    ).pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProfileExtensionPreflightFailed", stage: "skills" },
  });
  expect(activationCalls).toBe(0);
  expect(existsSync(join(fixture.profilePath, "automations"))).toBe(false);
});

test("runtime activation rejects exact selection-byte drift before activating owned automation", async () => {
  const fixture = await makeProfile();
  const automationId = "runtime-owned-job";
  await writeAutomationPackage(fixture.profilePath, "runtime-owned", automationId);
  const original = await writeSelection(fixture.profilePath, ["runtime-owned"]);
  const preparedSnapshot = await Effect.runPromise(snapshotExtensionSelection(fixture.profilePath));
  const activationCalls = { install: 0, resume: 0 };
  const automation: ProfileExtensionAutomationOperations = {
    files: automationFileStore,
    install: (target, id, source) => {
      activationCalls.install += 1;
      return installAutomationDefinition(target, id, source);
    },
    remove: removeAutomationDefinition,
    pause: pauseAutomationDefinition,
    resume: (target, id) => {
      activationCalls.resume += 1;
      return resumeAutomationDefinition(target, id);
    },
  };
  const service = makeService(noPreflight, noLock, automation);

  const preparation = await Effect.runPromise(
    service.prepareRuntime(fixture.profilePath, fixture.repositoryRoot),
  );
  expect(preparation).toEqual({
    selected: ["runtime-owned"],
    generation: extensionSelectionGeneration(preparedSnapshot),
  });

  const reformatted = Buffer.from('{"extensions":["runtime-owned"]}\n');
  expect(reformatted).not.toEqual(Buffer.from(original));
  await writeFile(join(fixture.profilePath, "extensions.json"), reformatted);
  const changedSnapshot = await Effect.runPromise(snapshotExtensionSelection(fixture.profilePath));
  expect(changedSnapshot.selected).toEqual(preparation.selected);
  expect(extensionSelectionGeneration(changedSnapshot)).not.toBe(preparation.generation);

  const result = await Effect.runPromise(
    service
      .activateRuntime(fixture.profilePath, fixture.repositoryRoot, preparation)
      .pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "ProfileExtensionInvalid",
      path: join(fixture.profilePath, "extensions.json"),
      message: "Profile extension selection changed while the Pi runtime was being constructed",
    },
  });
  expect(activationCalls).toEqual({ install: 0, resume: 0 });
  expect(existsSync(join(fixture.profilePath, "automations", `${automationId}.md`))).toBe(false);
  expect(existsSync(join(fixture.profilePath, "automations", `${automationId}.paused.md`))).toBe(
    false,
  );
});

test("post-selection automation provisioning rolls selection back", async () => {
  const fixture = await makeProfile();
  const automationId = "post-selection";
  await writeAutomationPackage(fixture.profilePath, "post-selection", automationId);
  const bytes = await writeSelection(fixture.profilePath, []);
  const preflight: ProfileExtensionPreflightApi = {
    preflight: (profilePath) =>
      Effect.tryPromise({
        try: async () => {
          const directory = join(profilePath, "automations");
          await mkdir(directory, { recursive: true });
          const source = automationSource("extension:post-selection");
          await writeFile(join(directory, `${automationId}.md`), source);
          await writeFile(join(directory, `${automationId}.paused.md`), source);
          return preflightCounts;
        },
        catch: (cause) =>
          new ProfileExtensionPreflightFailed({
            profilePath,
            stage: "services",
            message: "test preflight setup failed",
            diagnostics: [],
            cause,
          }),
      }),
  };
  const service = makeService(preflight);

  const result = await Effect.runPromise(
    service.add(fixture.target, fixture.repositoryRoot, "post-selection").pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ExtensionCatalogInstallFailed" },
  });
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(bytes);
});

test("multi-package activation failure cleans every earlier activation and restores compact selection bytes", async () => {
  const fixture = await makeProfile();
  await writeAutomationPackage(fixture.profilePath, "alpha", "alpha-job");
  await writeAutomationPackage(fixture.profilePath, "beta", "beta-job");
  const original = Buffer.from('{ "extensions" : [ ] }\r\n');
  await writeFile(join(fixture.profilePath, "extensions.json"), original);

  const result = await Effect.runPromise(
    makeService(noPreflight, noLock, makeAutomationOperations(true, false))
      .setSelected(fixture.target, fixture.repositoryRoot, ["alpha", "beta"])
      .pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ExtensionCatalogInstallFailed" },
  });
  expect(Buffer.from(await readFile(join(fixture.profilePath, "extensions.json")))).toEqual(
    original,
  );
  expect(existsSync(join(fixture.profilePath, "automations", "alpha-job.md"))).toBe(false);
  expect(existsSync(join(fixture.profilePath, "automations", "alpha-job.paused.md"))).toBe(false);
  expect(existsSync(join(fixture.profilePath, "automations", "beta-job.md"))).toBe(false);
  expect(existsSync(join(fixture.profilePath, "automations", "beta-job.paused.md"))).toBe(false);
});
test("multi-package activation rollback returns a pre-existing paused automation to paused", async () => {
  const fixture = await makeProfile();
  await writeAutomationPackage(fixture.profilePath, "alpha", "alpha-job");
  await writeAutomationPackage(fixture.profilePath, "beta", "beta-job");
  const original = await writeSelection(fixture.profilePath, []);
  const pausedPath = join(fixture.profilePath, "automations", "alpha-job.paused.md");
  const alphaSource = automationSource("extension:alpha");
  await mkdir(join(fixture.profilePath, "automations"), { recursive: true });
  await writeFile(pausedPath, alphaSource);

  const result = await Effect.runPromise(
    makeService(noPreflight, noLock, makeAutomationOperations(true, false))
      .setSelected(fixture.target, fixture.repositoryRoot, ["alpha", "beta"])
      .pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ExtensionCatalogInstallFailed" },
  });
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(original);
  expect(existsSync(join(fixture.profilePath, "automations", "alpha-job.md"))).toBe(false);
  expect(existsSync(pausedPath)).toBe(true);
  expect(await readFile(pausedPath, "utf8")).toBe(alphaSource);
  expect(existsSync(join(fixture.profilePath, "automations", "beta-job.md"))).toBe(false);
});

test("rollback failure is a bounded typed error that preserves the uncertain state", async () => {
  const fixture = await makeProfile();
  await writeAutomationPackage(fixture.profilePath, "alpha", "alpha-job");
  await writeAutomationPackage(fixture.profilePath, "beta", "beta-job");
  const original = await writeSelection(fixture.profilePath, []);

  const result = await Effect.runPromise(
    makeService(noPreflight, noLock, makeAutomationOperations(true, true))
      .setSelected(fixture.target, fixture.repositoryRoot, ["alpha", "beta"])
      .pipe(Effect.result),
  );

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.failure).toBeInstanceOf(ProfileExtensionRollbackFailed);
  if (result.failure._tag !== "ProfileExtensionRollbackFailed") return;
  expect(result.failure.originalFailure).toMatchObject({ _tag: "ExtensionCatalogInstallFailed" });
  expect(result.failure.rollbackFailures).toHaveLength(1);
  expect(result.failure.rollbackFailures[0]?.message.length).toBeLessThanOrEqual(360);
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(original);
  expect(existsSync(join(fixture.profilePath, "automations", "alpha-job.md"))).toBe(true);
  expect(existsSync(join(fixture.profilePath, "automations", "beta-job.md"))).toBe(false);
});

test("failed add restores an originally absent selection file", async () => {
  const fixture = await makeProfile();
  await writeAutomationPackage(fixture.profilePath, "beta", "beta-job");

  const result = await Effect.runPromise(
    makeService(noPreflight, noLock, makeAutomationOperations(true, false))
      .add(fixture.target, fixture.repositoryRoot, "beta")
      .pipe(Effect.result),
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ExtensionCatalogInstallFailed" },
  });
  expect(existsSync(join(fixture.profilePath, "extensions.json"))).toBe(false);
  expect(existsSync(join(fixture.profilePath, "automations", "beta-job.md"))).toBe(false);
});

test("removing a stale unknown ID changes only the selection", async () => {
  const fixture = await makeProfile();
  const originalSoul = await readFile(join(fixture.profilePath, "SOUL.md"));
  await writeSelection(fixture.profilePath, ["retired-package"]);

  const result = await Effect.runPromise(
    makeService(makeProfileExtensionPreflight(), noLock).remove(
      fixture.target,
      fixture.repositoryRoot,
      "retired-package",
    ),
  );

  expect(result).toEqual({
    id: "retired-package",
    profilePath: fixture.profilePath,
    changed: true,
    selected: false,
  });
  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(
    '{\n  "extensions": []\n}\n',
  );
  expect(await readFile(join(fixture.profilePath, "SOUL.md"))).toEqual(originalSoul);
  expect(existsSync(join(fixture.profilePath, "extensions"))).toBe(false);
});

test("validate uses real services without creating runtime state or changing Profile bytes", async () => {
  const fixture = await makeProfile();
  await writeShelfPackage(fixture.profilePath, "alpha");
  await writeSelection(fixture.profilePath, ["alpha"]);
  const before = await profileTree(fixture.profilePath);
  expect(existsSync(join(fixture.profilePath, ".runtime"))).toBe(false);
  const service = makeService(makeProfileExtensionPreflight(), makeProfileExtensionMutationLock());

  const validation = await Effect.runPromise(
    service.validate(fixture.target, join(import.meta.dir, "../..")),
  );

  expect(validation.selected).toEqual(["alpha"]);
  expect(validation.preflight.skillPathCount).toBeGreaterThan(0);
  expect(await profileTree(fixture.profilePath)).toEqual(before);
  expect(existsSync(join(fixture.profilePath, ".runtime"))).toBe(false);
});

test("independent lock users serialize full read-validate-commit operations without lost updates", async () => {
  const fixture = await makeProfile();
  await writeShelfPackage(fixture.profilePath, "alpha");
  await writeShelfPackage(fixture.profilePath, "beta");
  await writeSelection(fixture.profilePath, []);
  const delayedPreflight: ProfileExtensionPreflightApi = {
    preflight: () => Effect.sleep("80 millis").pipe(Effect.as(preflightCounts)),
  };
  const first = makeService(delayedPreflight, makeProfileExtensionMutationLock());
  const second = makeService(delayedPreflight, makeProfileExtensionMutationLock());

  await Promise.all([
    Effect.runPromise(first.add(fixture.target, fixture.repositoryRoot, "alpha")),
    Effect.runPromise(second.add(fixture.target, fixture.repositoryRoot, "beta")),
  ]);

  expect(await readFile(join(fixture.profilePath, "extensions.json"), "utf8")).toBe(
    '{\n  "extensions": [\n    "alpha",\n    "beta"\n  ]\n}\n',
  );
});
