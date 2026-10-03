/**
 * Scratch Profiles for proofs. Each lives in its own tmp `ZIGGY_HOME`, so nothing a proof does can
 * reach a real Profile, and `treeHash` proves a command left the folder untouched.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ModelServer } from "./provider";

export interface ScratchProfile {
  /** `HOME` for every child process; holds `home` and anything else a child writes. */
  readonly root: string;
  /** `ZIGGY_HOME`. */
  readonly home: string;
  readonly path: string;
  readonly soul: string;
  readonly remove: () => Promise<void>;
}

const SOUL = "# Harness\n\nYou are the harness Profile. SOUL_MARKER_7f3a\n";

/** A Profile folder wired to `server` as provider `harness`, model `harness-model`. */
export const scratchProfile = async (server: ModelServer): Promise<ScratchProfile> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-e2e-"));
  const home = join(root, "ziggy");
  const path = join(home, "profiles", "harness");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SOUL.md"), SOUL, "utf8");
  await writeFile(
    join(path, "settings.json"),
    JSON.stringify({ defaultProvider: "harness", defaultModel: "harness-model" }),
    "utf8",
  );
  await writeModels(path, server);

  return { root, home, path, soul: SOUL, remove: () => rm(root, { recursive: true, force: true }) };
};

const writeModels = (path: string, server: ModelServer): Promise<void> =>
  writeFile(
    join(path, "models.json"),
    JSON.stringify({
      providers: {
        harness: {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "harness-key",
          models: [{ id: "harness-model" }, { id: "harness-other" }],
        },
      },
    }),
    "utf8",
  );

const walk = async (root: string, directory: string, into: Array<string>): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      into.push(`d ${relative(root, full)}`);
      await walk(root, full, into);
    } else {
      const stat = await lstat(full);
      const bytes = entry.isFile() ? await readFile(full) : Buffer.from("");
      const digest = createHash("sha256").update(bytes).digest("hex");
      into.push(`f ${relative(root, full)} ${stat.mode.toString(8)} ${digest}`);
    }
  }
};

/** Every path, mode and content digest under `root`; equal hashes mean nothing changed. */
export const treeHash = async (root: string): Promise<string> => {
  const lines: Array<string> = [];
  await walk(root, root, lines);

  return lines.join("\n");
};

/** Every `.jsonl` session file under the Profile's `sessions/`, relative to it. */
export const sessionFiles = async (path: string): Promise<ReadonlyArray<string>> => {
  const directory = join(path, "sessions");
  const found = await readdir(directory, { recursive: true }).catch(() => []);

  return found.filter((file) => file.endsWith(".jsonl")).toSorted();
};
