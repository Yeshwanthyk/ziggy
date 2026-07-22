import { afterAll, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeTreeDigest,
  loadInstalledExtensionSkills,
  sha256,
  type ExtensionManifest,
  type ExtensionProvenanceFile,
} from "../../packages/core/src/index.ts";
import { runEffect } from "../testkit/effect.ts";

const profiles: string[] = [];

const baseManifest: ExtensionManifest = {
  schemaVersion: 1,
  id: "fixture",
  version: "1.0.0",
  name: "Fixture",
  description: "Sealed Skill fixture.",
  ziggy: { requires: ">=0.0.0 <=9.0.0" },
  skills: [{ id: "fixture", path: "skills/fixture" }],
  adapters: [],
  requires: { env: [], commands: [], os: [] },
  permissions: { network: false, filesystem: "none", secrets: [] },
  distribution: { source: "fixture", license: "MIT" },
};

test("loads an enabled, identity-matched, sealed Skill and its reachable support file", async () => {
  const profile = await createFixture("valid", {
    files: {
      "skills/fixture/SKILL.md": skill("fixture", "Read [the guide](references/guide.md)."),
      "skills/fixture/references/guide.md": "# Guide\n",
    },
  });
  expect(await runEffect(loadInstalledExtensionSkills(profile, "1.0.0"))).toEqual([
    {
      extensionId: "fixture",
      id: "fixture",
      content: skill("fixture", "Read [the guide](references/guide.md)."),
    },
  ]);
});

test("rejects incompatibility before reading Skill bytes or daemon authority", async () => {
  const profile = await createFixture("incompatible", {
    manifest: { ...baseManifest, ziggy: { requires: ">9.0.0" } },
    writeAuthority: false,
    files: { "skills/fixture/SKILL.md": "not valid Skill bytes" },
  });
  await expect(runEffect(loadInstalledExtensionSkills(profile, "1.0.0"))).rejects.toThrow(
    "requires Ziggy >9.0.0",
  );
});

test("skips a disabled Extension before reading its immutable tree", async () => {
  const profile = await createFixture("disabled", {
    enabled: false,
    files: { "skills/fixture/SKILL.md": "mutated and unsealed" },
  });
  expect(await runEffect(loadInstalledExtensionSkills(profile, "1.0.0"))).toEqual([]);
});

test("rejects Extension, Skill-root, and frontmatter identity mismatches", async () => {
  const extensionMismatch = await createFixture("extension-identity", {
    directoryName: "other",
    files: { "skills/fixture/SKILL.md": skill("fixture", "Body.") },
  });
  await expect(runEffect(loadInstalledExtensionSkills(extensionMismatch, "1.0.0"))).rejects.toThrow(
    "directory basename",
  );

  const skillMismatch = await createFixture("skill-identity", {
    files: { "skills/fixture/SKILL.md": skill("other", "Body.") },
  });
  await expect(runEffect(loadInstalledExtensionSkills(skillMismatch, "1.0.0"))).rejects.toThrow(
    "frontmatter name",
  );
});

test("rejects a declared Tool without its immediate entrypoint", async () => {
  const profile = await createFixture("missing-tool", {
    manifest: {
      ...baseManifest,
      skills: [],
      tools: [{ id: "fixture", path: "tools/fixture" }],
    },
    files: {},
  });
  await expect(runEffect(loadInstalledExtensionSkills(profile, "1.0.0"))).rejects.toThrow(
    "Missing immediate tools/fixture/tool.ts",
  );
});

test("rejects symbolic links and hard links in immutable Extension trees", async () => {
  const symlinkProfile = await createFixture("symlink", {
    files: { "skills/fixture/SKILL.md": skill("fixture", "Body.") },
  });
  const symlinkRoot = join(symlinkProfile, "extensions", "fixture", "skills", "fixture");
  await writeFile(join(symlinkRoot, "target.md"), "target");
  await symlink("target.md", join(symlinkRoot, "alias.md"));
  await expect(runEffect(loadInstalledExtensionSkills(symlinkProfile, "1.0.0"))).rejects.toThrow(
    "Failed to read immutable tree",
  );

  const hardlinkProfile = await createFixture("hardlink", {
    files: { "skills/fixture/SKILL.md": skill("fixture", "Body.") },
  });
  const hardlinkRoot = join(hardlinkProfile, "extensions", "fixture", "skills", "fixture");
  await link(join(hardlinkRoot, "SKILL.md"), join(hardlinkRoot, "alias.md"));
  await expect(runEffect(loadInstalledExtensionSkills(hardlinkProfile, "1.0.0"))).rejects.toThrow(
    "Failed to read immutable tree",
  );
});

test("rejects escaping, dangling, orphan, and cyclic Skill support links", async () => {
  const cases = [
    {
      name: "escape",
      files: { "skills/fixture/SKILL.md": skill("fixture", "[escape](../other.md)") },
      message: "Unsupported local Skill link",
    },
    {
      name: "dangling",
      files: { "skills/fixture/SKILL.md": skill("fixture", "[missing](references/no.md)") },
      message: "Dangling Skill link",
    },
    {
      name: "orphan",
      files: {
        "skills/fixture/SKILL.md": skill("fixture", "Body."),
        "skills/fixture/references/orphan.md": "orphan",
      },
      message: "Orphan Skill support file",
    },
    {
      name: "cycle",
      files: {
        "skills/fixture/SKILL.md": skill("fixture", "[a](references/a.md)"),
        "skills/fixture/references/a.md": "[b](b.md)",
        "skills/fixture/references/b.md": "[a](a.md)",
      },
      message: "Cyclic Skill link",
    },
  ];
  for (const fixture of cases) {
    const profile = await createFixture(fixture.name, { files: fixture.files });
    await expect(runEffect(loadInstalledExtensionSkills(profile, "1.0.0"))).rejects.toThrow(
      fixture.message,
    );
  }
});

test("rejects drive-prefixed Skill links while ignoring external schemes", async () => {
  const driveDestinations = [
    "C:/outside.md",
    "C:outside.md",
    "c:/outside.md",
    "c:outside.md",
    "%43%3A/outside.md",
    "%63%3Aoutside.md",
  ];
  for (const destination of driveDestinations) {
    const profile = await createFixture(`drive-${driveDestinations.indexOf(destination)}`, {
      files: {
        "skills/fixture/SKILL.md": skill("fixture", `[drive](${destination})`),
      },
    });
    await expect(runEffect(loadInstalledExtensionSkills(profile, "1.0.0"))).rejects.toThrow(
      "Unsupported local Skill link",
    );
  }

  const externalProfile = await createFixture("external-scheme", {
    files: {
      "skills/fixture/SKILL.md": skill(
        "fixture",
        "Read [the external guide](https://example.test/guide.md).",
      ),
    },
  });
  expect(await runEffect(loadInstalledExtensionSkills(externalProfile, "1.0.0"))).toHaveLength(1);
});

test("rejects post-seal mutation", async () => {
  const profile = await createFixture("mutation", {
    files: { "skills/fixture/SKILL.md": skill("fixture", "Original.") },
  });
  await writeFile(
    join(profile, "extensions", "fixture", "skills", "fixture", "SKILL.md"),
    skill("fixture", "Mutated."),
  );
  await expect(runEffect(loadInstalledExtensionSkills(profile, "1.0.0"))).rejects.toThrow(
    "Sealed Extension file mutated",
  );
});

test("fails closed on unexpected Extension entries, unknown files, and forged catalog kinds", async () => {
  const unexpectedEntry = await createFixture("unexpected-entry", {
    files: { "skills/fixture/SKILL.md": skill("fixture", "Body.") },
  });
  await writeFile(join(unexpectedEntry, "extensions", "stray"), "not an Extension");
  await expect(runEffect(loadInstalledExtensionSkills(unexpectedEntry, "1.0.0"))).rejects.toThrow(
    "Failed to discover installed Extensions",
  );

  const unknownFile = await createFixture("unknown-file", {
    files: {
      "skills/fixture/SKILL.md": skill("fixture", "Body."),
      "unexpected.txt": "sealed but unsupported",
    },
  });
  await expect(runEffect(loadInstalledExtensionSkills(unknownFile, "1.0.0"))).rejects.toThrow(
    "Unknown immutable Extension file",
  );

  const forgedKind = await createFixture("forged-kind", {
    files: { "skills/fixture/SKILL.md": skill("fixture", "Body.") },
    skillKind: "support",
  });
  await expect(runEffect(loadInstalledExtensionSkills(forgedKind, "1.0.0"))).rejects.toThrow(
    "Provenance file kind mismatch",
  );
});

test("rejects aliased daemon-owned Extension authority", async () => {
  const profile = await createFixture("authority-link", {
    files: { "skills/fixture/SKILL.md": skill("fixture", "Body.") },
  });
  const authorityRoot = join(profile, ".runtime", "extensions", "fixture");
  const authorityTarget = join(profile, "authority-target");
  await mkdir(authorityTarget);
  await writeFile(
    join(authorityTarget, "state.json"),
    JSON.stringify({ schemaVersion: 1, extensionId: "fixture", enabled: true }),
  );
  await rm(authorityRoot, { recursive: true });
  await symlink(authorityTarget, authorityRoot);
  await expect(runEffect(loadInstalledExtensionSkills(profile, "1.0.0"))).rejects.toThrow(
    "Failed to read daemon-owned authority",
  );
});

interface FixtureOptions {
  readonly directoryName?: string;
  readonly manifest?: ExtensionManifest;
  readonly files: Readonly<Record<string, string>>;
  readonly enabled?: boolean;
  readonly writeAuthority?: boolean;
  readonly skillKind?: string;
}

async function createFixture(name: string, options: FixtureOptions): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), `ziggy-s4-skill-loader-${name}-`));
  profiles.push(profile);
  const manifest = options.manifest ?? baseManifest;
  const directoryName = options.directoryName ?? manifest.id;
  const extensionRoot = join(profile, "extensions", directoryName);
  const authorityRoot = join(profile, ".runtime", "extensions", manifest.id);
  await mkdir(extensionRoot, { recursive: true });
  const manifestJson = JSON.stringify(manifest);
  await writeFixtureFile(extensionRoot, "extension.json", manifestJson);
  for (const [path, contents] of Object.entries(options.files)) {
    await writeFixtureFile(extensionRoot, path, contents);
  }
  if (options.writeAuthority === false) return profile;
  await mkdir(authorityRoot, { recursive: true });
  await writeFile(
    join(authorityRoot, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensionId: manifest.id,
      enabled: options.enabled ?? true,
    }),
  );
  const files = [
    catalogFile("extension.json", manifestJson, "manifest"),
    ...Object.entries(options.files).map(([path, contents]) =>
      catalogFile(
        path,
        contents,
        path.endsWith("SKILL.md") ? (options.skillKind ?? "skill") : "support",
      ),
    ),
  ].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  await writeFile(
    join(authorityRoot, "provenance.json"),
    JSON.stringify({
      schemaVersion: 1,
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      source: { kind: "fixture", locator: name },
      trustTier: "community",
      verification: { method: "none", keyId: "", signature: "" },
      files,
      treeDigest: computeTreeDigest(files),
    }),
  );
  return profile;
}

async function writeFixtureFile(root: string, path: string, contents: string): Promise<void> {
  const segments = path.split("/");
  const directory = segments.slice(0, -1).join("/");
  if (directory !== "") await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, path), contents);
}

function catalogFile(path: string, contents: string, kind: string): ExtensionProvenanceFile {
  const bytes = new TextEncoder().encode(contents);
  return { path, kind, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function skill(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Fixture Skill\n---\n\n${body}\n`;
}

afterAll(async () => {
  await Promise.all(profiles.map((profile) => rm(profile, { recursive: true, force: true })));
});
