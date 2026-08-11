/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures own temporary filesystem setup */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ExtensionArchiveClientShape } from "../adapters/github/extension-catalog";
import { ExtensionCatalogUnavailable, type ExtensionCatalog } from "../domain/extension-catalog";
import { makeExtensionCatalogLive } from "./extension-catalog";

const roots: string[] = [];
const repositoryRoot = join(import.meta.dir, "../..");
const noDownload: ExtensionArchiveClientShape = {
  download: () =>
    Effect.fail(
      new ExtensionCatalogUnavailable({
        operation: "test download",
        message: "bundled catalogue entry must not use the network",
        cause: undefined,
      }),
    ),
};

const makeProfile = async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-extension-catalog-"));
  roots.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath);
  await writeFile(join(profilePath, "SOUL.md"), "# Test\n");
  return profilePath;
};

const writeSkillPackage = async (repositoryPath: string, id: string, description: string) => {
  const skillPath = join(repositoryPath, "extensions", id, "skills", id);
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(repositoryPath, "extensions", id, "package.json"),
    `${JSON.stringify({
      name: `@ziggy/${id}`,
      version: "0.1.0",
      description,
      pi: { skills: ["./skills"] },
    })}\n`,
  );
  await writeFile(
    join(skillPath, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n`,
  );
};

const withCatalog = async <A>(
  use: (profilePath: string, catalog: ReturnType<typeof makeExtensionCatalogLive>) => Promise<A>,
) => use(await makeProfile(), makeExtensionCatalogLive(noDownload));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("approved extension catalogue", () => {
  test("lists only JSON-approved packages and rejects an unlisted repository directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ziggy-catalog-authority-"));
    roots.push(root);
    const repositoryPath = join(root, "repository");
    const profilePath = await makeProfile();
    await writeSkillPackage(repositoryPath, "approved", "Approved package");
    await writeSkillPackage(repositoryPath, "stray", "Unapproved package");
    const catalog: ExtensionCatalog = {
      version: 1,
      extensions: [
        {
          id: "approved",
          version: "0.1.0",
          source: "bundled",
          path: "./extensions/approved",
        },
      ],
    };
    const service = makeExtensionCatalogLive(noDownload, catalog);

    expect(await Effect.runPromise(service.list(repositoryPath))).toEqual([
      {
        id: "approved",
        version: "0.1.0",
        description: "Approved package",
        kind: "skill",
        required: false,
        source: "bundled",
        installed: true,
        packagePath: join(repositoryPath, "extensions", "approved"),
        skills: [{ name: "approved", description: "Approved package" }],
        extensionPaths: [],
      },
    ]);
    const failure = await Effect.runPromise(
      Effect.flip(service.ensureInstalled(profilePath, repositoryPath, "stray")),
    );
    expect(failure._tag).toBe("ExtensionCatalogInvalid");
  });

  test("installs the Curator package and its owned automation into only the Profile", async () => {
    await withCatalog(async (profilePath, catalog) => {
      const installed = await Effect.runPromise(
        catalog.ensureInstalled(profilePath, repositoryRoot, "self-improvement"),
      );
      expect(installed).toBe(join(profilePath, "extensions", "self-improvement"));
      expect(await readFile(join(installed, "package.json"), "utf8")).toContain(
        '"name": "@ziggy/self-improvement"',
      );
      expect(
        await readFile(join(profilePath, "automations", "self-improvement-curator.md"), "utf8"),
      ).toContain("owner: extension:self-improvement");

      expect(
        await Effect.runPromise(
          catalog.ensureInstalled(profilePath, repositoryRoot, "self-improvement"),
        ),
      ).toBe(installed);

      await Effect.runPromise(catalog.deactivate(profilePath, repositoryRoot, "self-improvement"));
      expect(
        await readFile(
          join(profilePath, "automations", "self-improvement-curator.paused.md"),
          "utf8",
        ),
      ).toContain("owner: extension:self-improvement");
    });
  });

  test("never overwrites a colliding Profile automation", async () => {
    await withCatalog(async (profilePath, catalog) => {
      const automationPath = join(profilePath, "automations", "self-improvement-curator.md");
      await mkdir(join(profilePath, "automations"));
      await writeFile(automationPath, "human-owned\n");

      const failure = await Effect.runPromise(
        Effect.flip(catalog.ensureInstalled(profilePath, repositoryRoot, "self-improvement")),
      );

      expect(failure._tag).toBe("ExtensionCatalogInstallFailed");
      expect(await readFile(automationPath, "utf8")).toBe("human-owned\n");
    });
  });
});
