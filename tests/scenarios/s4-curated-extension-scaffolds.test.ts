import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeExtensionManifestJson } from "../../packages/core/src/extensions/index.ts";
import { runEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

test("curated smart-memory and smart-extensions packages are inert scaffolds", async () => {
  for (const id of ["smart-extensions", "smart-memory"]) {
    const root = join(repositoryRoot, "extensions", id);
    expect((await readdir(root)).sort()).toEqual(["extension.json", "skills"]);
    expect(await readdir(join(root, "skills"))).toEqual([id]);
    expect(await readdir(join(root, "skills", id))).toEqual(["SKILL.md"]);

    const manifest = await runEffect(
      decodeExtensionManifestJson(await readFile(join(root, "extension.json"), "utf8")),
    );
    expect(manifest.id).toBe(id);
    expect(manifest.skills).toEqual([{ id, path: `skills/${id}` }]);
    expect(manifest.tools).toBeUndefined();
    expect(manifest.setup).toBeUndefined();
    expect(manifest.requires).toEqual({ env: [], commands: [], os: [] });
    expect(manifest.permissions).toEqual({ network: false, filesystem: "none", secrets: [] });

    const skill = await readFile(join(root, "skills", id, "SKILL.md"), "utf8");
    expect(skill).toStartWith(`---\nname: ${id}\n`);
    expect(skill).toContain("placeholder only");
    expect(skill).toContain("must not");
    expect(skill.replaceAll(/\s+/g, " ")).toContain(
      "no Tool, setup, doctor, command, environment, secret, network, filesystem, or mutable-state authority",
    );
  }

  emitVerificationObservation("s4.curated-extension-scaffolds", {
    ...emptyRuntimeObservations(),
    metrics: [
      { name: "scaffold-extensions", value: 2 },
      { name: "declared-tools", value: 0 },
      { name: "declared-commands", value: 0 },
      { name: "declared-secrets", value: 0 },
    ],
  });
});
