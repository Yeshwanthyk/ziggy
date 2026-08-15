/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- fixtures own temporary filesystem setup */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { ExtensionArchiveClientApi } from "ziggy/adapters/github/extension-catalog";
import { ExtensionCatalogUnavailable } from "ziggy/domain/extension-catalog";
import { makeExtensionCatalogLive } from "ziggy/application/extension-catalog";

const roots: string[] = [];
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

const makeProfile = async () => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-extension-catalog-"));
  roots.push(root);
  const profilePath = join(root, "profile");
  await mkdir(profilePath);
  await writeFile(join(profilePath, "SOUL.md"), "# Test\n");
  return profilePath;
};

const withCatalog = async <A>(
  use: (profilePath: string, catalog: ReturnType<typeof makeExtensionCatalogLive>) => Promise<A>,
) => use(await makeProfile(), makeExtensionCatalogLive(noDownload));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("approved extension catalogue", () => {
  test("lists bundled metadata without scanning a checkout and rejects unknown IDs", async () => {
    const profilePath = await makeProfile();
    const catalog = makeExtensionCatalogLive(noDownload);
    const listed = await Effect.runPromise(catalog.list("/does-not-exist"));
    const selfImprovement = listed.find((entry) => entry.id === "self-improvement");

    expect(listed.some((entry) => entry.id === "stray")).toBe(false);
    expect(selfImprovement).toMatchObject({
      id: "self-improvement",
      source: "bundled",
      installed: true,
      required: false,
      packagePath: "extensions/self-improvement",
      kind: "skill+code",
    });
    const failure = await Effect.runPromise(
      Effect.flip(catalog.ensureInstalled(profilePath, "/does-not-exist", "stray")),
    );
    expect(failure._tag).toBe("ExtensionCatalogInvalid");
  });

  test("selecting a bundled package copies it into the Profile and provisions owned automations", async () => {
    await withCatalog(async (profilePath, catalog) => {
      const installed = await Effect.runPromise(
        catalog.ensureInstalled(profilePath, "/does-not-exist", "self-improvement"),
      );
      const packagePath = join(profilePath, "extensions", "self-improvement");
      expect(installed).toBe(packagePath);
      expect(await readFile(join(packagePath, "package.json"), "utf8")).toContain(
        "@ziggy/self-improvement",
      );
      expect(await readFile(join(packagePath, "skills", "curator", "SKILL.md"), "utf8")).toContain(
        "self_improvement_status",
      );
      expect(
        await readFile(join(profilePath, "automations", "self-improvement-curator.md"), "utf8"),
      ).toContain("owner: extension:self-improvement");

      expect(
        await Effect.runPromise(
          catalog.ensureInstalled(profilePath, "/does-not-exist", "self-improvement"),
        ),
      ).toBe(installed);

      await Effect.runPromise(
        catalog.deactivate(profilePath, "/does-not-exist", "self-improvement"),
      );
      expect(
        await readFile(
          join(profilePath, "automations", "self-improvement-curator.paused.md"),
          "utf8",
        ),
      ).toContain("owner: extension:self-improvement");
    });
  });

  test("materialize copies required packages and every selected ID onto the Profile", async () => {
    await withCatalog(async (profilePath, catalog) => {
      await writeFile(join(profilePath, "extensions.json"), '{"extensions":["apple-reminders"]}\n');
      await Effect.runPromise(catalog.materialize(profilePath, "/does-not-exist"));

      expect(
        await readFile(join(profilePath, "extensions", "pi-packages", "package.json"), "utf8"),
      ).toContain("@ziggy/pi-packages");
      expect(
        await readFile(
          join(
            profilePath,
            "extensions",
            "extension-authoring",
            "skills",
            "extension-authoring",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).toContain("Create or change a Profile-owned Pi extension");
      expect(
        await readFile(
          join(
            profilePath,
            "extensions",
            "ziggy-operations",
            "skills",
            "ziggy-operations",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).toContain("Operate Ziggy Profiles");
      expect(
        await readFile(
          join(profilePath, "extensions", "apple-reminders", "scripts", "reminders.applescript"),
          "utf8",
        ),
      ).toContain("list-incomplete");
    });
  });

  test("never overwrites a colliding Profile automation", async () => {
    await withCatalog(async (profilePath, catalog) => {
      const automationPath = join(profilePath, "automations", "self-improvement-curator.md");
      await mkdir(join(profilePath, "automations"));
      await writeFile(automationPath, "human-owned\n");

      const failure = await Effect.runPromise(
        Effect.flip(catalog.ensureInstalled(profilePath, "/does-not-exist", "self-improvement")),
      );

      expect(failure._tag).toBe("ExtensionCatalogInstallFailed");
      expect(await readFile(automationPath, "utf8")).toBe("human-owned\n");
    });
  });
});
