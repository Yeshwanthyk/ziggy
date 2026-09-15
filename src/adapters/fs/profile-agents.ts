import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Predicate, Schema, Semaphore } from "effect";
import {
  ProfileAgent,
  ProfileAgentEditConflict,
  ProfileAgentInvalid,
  ProfileFileSystemError,
} from "../../domain/profile";
import { fileSystemCauseDetails } from "./cause";

const decodeProfileAgent = Schema.decodeUnknownEffect(ProfileAgent, {
  onExcessProperty: "error",
});
const allowedFrontmatterFields = new Set([
  "version",
  "description",
  "provider",
  "model",
  "thinking",
  "tools",
]);

const fsError = (operation: string, targetPath: string, cause: unknown) => {
  const details = fileSystemCauseDetails(cause);
  return new ProfileFileSystemError({
    operation,
    path: targetPath,
    message: details.message,
    code: details.code,
    cause,
  });
};

const invalid = (targetPath: string, message: string, cause?: unknown) =>
  new ProfileAgentInvalid({ path: targetPath, message, cause });

const inspect = (targetPath: string) =>
  Effect.tryPromise({
    try: () => lstat(targetPath),
    catch: (cause) => fsError("inspect", targetPath, cause),
  });

const editLocks = new Map<string, Semaphore.Semaphore>();
const editLock = (targetPath: string): Semaphore.Semaphore => {
  const existing = editLocks.get(targetPath);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  editLocks.set(targetPath, created);
  return created;
};

const readPhysicalText = async (targetPath: string, signal?: AbortSignal): Promise<string> => {
  const handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile({ encoding: "utf8", signal });
  } finally {
    await handle.close();
  }
};

const readText = (targetPath: string) =>
  Effect.tryPromise({
    try: (signal) => readPhysicalText(targetPath, signal),
    catch: (cause) => fsError("read", targetPath, cause),
  });

const parseScalar = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1).trim()
    : trimmed;
};

const parseFrontmatter = (
  targetPath: string,
  text: string,
): Effect.Effect<
  { readonly fields: ReadonlyMap<string, string>; readonly body: string },
  ProfileAgentInvalid
> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) {
    return Effect.fail(invalid(targetPath, `Profile agent is missing frontmatter: ${targetPath}`));
  }

  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const field = /^([a-z][a-z0-9-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (field === null || field[2] === undefined) {
      return Effect.fail(
        invalid(targetPath, `Profile agent has invalid frontmatter: ${targetPath}`),
      );
    }
    const name = field[1];
    if (name === undefined || fields.has(name)) {
      return Effect.fail(
        invalid(targetPath, `Profile agent has duplicate frontmatter: ${targetPath}`),
      );
    }
    fields.set(name, parseScalar(field[2]));
  }

  const body = text.slice(match[0].length).trim();
  if (body.length === 0) {
    return Effect.fail(invalid(targetPath, `Profile agent body must be non-empty: ${targetPath}`));
  }
  return Effect.succeed({ fields, body });
};

interface ProfileAgentDecodeInput {
  readonly id: string;
  readonly version: number | string | undefined;
  readonly description: string | undefined;
  readonly body: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly tools?: ReadonlyArray<string>;
}

type ProfileAgentDecodeDraft = {
  -readonly [K in keyof ProfileAgentDecodeInput]: ProfileAgentDecodeInput[K];
};

const rawAgent = (
  id: string,
  fields: ReadonlyMap<string, string>,
  body: string,
): ProfileAgentDecodeInput => {
  const raw: ProfileAgentDecodeDraft = {
    id,
    version: fields.get("version") === "1" ? 1 : fields.get("version"),
    description: fields.get("description"),
    body,
  };
  for (const name of ["provider", "model", "thinking"] as const) {
    const value = fields.get(name);
    if (value !== undefined) {
      raw[name] = value;
    }
  }
  const tools = fields.get("tools");
  if (tools !== undefined) {
    raw.tools = tools.split(",").map((tool) => tool.trim());
  }
  return raw;
};

export const decodeProfileAgentSource = (targetPath: string, text: string) =>
  Effect.gen(function* () {
    const parsed = yield* parseFrontmatter(targetPath, text);
    const id = path.basename(targetPath, ".md");
    const unknownFields = [...parsed.fields.keys()].filter(
      (field) => !allowedFrontmatterFields.has(field),
    );
    if (unknownFields.length > 0) {
      return yield* invalid(
        targetPath,
        `Profile agent has unknown frontmatter field '${unknownFields[0]}': ${targetPath}`,
      );
    }
    return yield* decodeProfileAgent(rawAgent(id, parsed.fields, parsed.body)).pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "ProfileAgentInvalid")
          ? cause
          : invalid(targetPath, `Profile agent has an invalid contract: ${targetPath}`, cause),
      ),
    );
  });

const agentFiles = (agentsPath: string) =>
  Effect.tryPromise({
    try: () => readdir(agentsPath, { withFileTypes: true }),
    catch: (cause) => fsError("list", agentsPath, cause),
  }).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.name.endsWith(".md"))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  );

export const discoverProfileAgents = (
  profilePath: string,
): Effect.Effect<ReadonlyArray<ProfileAgent>, ProfileAgentInvalid | ProfileFileSystemError> => {
  const agentsPath = path.join(profilePath, "agents");
  return inspect(agentsPath).pipe(
    Effect.catchIf(
      (error) => Predicate.isTagged(error, "ProfileFileSystemError") && error.code === "ENOENT",
      () => Effect.void,
    ),
    Effect.flatMap((status) => {
      if (status === undefined) return Effect.succeed<ReadonlyArray<ProfileAgent>>([]);
      if (status.isSymbolicLink()) {
        return Effect.fail(
          invalid(agentsPath, `Profile agents root cannot be a symlink: ${agentsPath}`),
        );
      }
      if (!status.isDirectory()) {
        return Effect.fail(
          invalid(agentsPath, `Profile agents root is not a directory: ${agentsPath}`),
        );
      }
      return agentFiles(agentsPath).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries,
            (entry) => {
              const agentPath = path.join(agentsPath, entry.name);
              if (entry.isSymbolicLink()) {
                return Effect.fail(
                  invalid(agentPath, `Profile agent file cannot be a symlink: ${agentPath}`),
                );
              }
              if (!entry.isFile()) {
                return Effect.fail(invalid(agentPath, `Profile agent is not a file: ${agentPath}`));
              }
              return readText(agentPath).pipe(
                Effect.flatMap((text) => decodeProfileAgentSource(agentPath, text)),
              );
            },
            { concurrency: 1 },
          ),
        ),
      );
    }),
  );
};

export interface ProfileAgentFileObservation {
  readonly id: string;
  readonly path: string;
  readonly agent?: ProfileAgent;
  readonly error?: ProfileAgentInvalid | ProfileFileSystemError;
}

export const inspectProfileAgentFiles = (
  profilePath: string,
): Effect.Effect<
  ReadonlyArray<ProfileAgentFileObservation>,
  ProfileAgentInvalid | ProfileFileSystemError
> => {
  const agentsPath = path.join(profilePath, "agents");
  return inspect(agentsPath).pipe(
    Effect.catchIf(
      (error) => Predicate.isTagged(error, "ProfileFileSystemError") && error.code === "ENOENT",
      () => Effect.void,
    ),
    Effect.flatMap(
      (
        status,
      ): Effect.Effect<
        ReadonlyArray<ProfileAgentFileObservation>,
        ProfileAgentInvalid | ProfileFileSystemError
      > => {
        if (status === undefined)
          return Effect.succeed<ReadonlyArray<ProfileAgentFileObservation>>([]);
        if (status.isSymbolicLink() || !status.isDirectory()) {
          return Effect.fail(
            invalid(agentsPath, `Profile agents root must be a physical directory: ${agentsPath}`),
          );
        }
        return agentFiles(agentsPath).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(entries, (entry) => {
              const targetPath = path.join(agentsPath, entry.name);
              const id = entry.name.slice(0, -3);
              if (entry.isSymbolicLink() || !entry.isFile()) {
                return Effect.succeed({
                  id,
                  path: targetPath,
                  error: invalid(targetPath, `Profile agent is not a physical file: ${targetPath}`),
                });
              }
              return readText(targetPath).pipe(
                Effect.flatMap((source) => decodeProfileAgentSource(targetPath, source)),
                Effect.match({
                  onFailure: (error): ProfileAgentFileObservation => ({
                    id,
                    path: targetPath,
                    error,
                  }),
                  onSuccess: (agent): ProfileAgentFileObservation => ({
                    id,
                    path: targetPath,
                    agent,
                  }),
                }),
              );
            }),
          ),
        );
      },
    ),
  );
};

export const profileAgentTemplate = (id: string): string =>
  `---\nversion: 1\ndescription: Describe the ${id} specialist.\n---\n\nFollow the assigned task within this specialist role.\n`;

export const createProfileAgentFile = (
  profilePath: string,
  id: string,
): Effect.Effect<
  { readonly agent: ProfileAgent; readonly path: string },
  ProfileAgentInvalid | ProfileFileSystemError
> => {
  const agentsPath = path.join(profilePath, "agents");
  const targetPath = path.join(agentsPath, `${id}.md`);
  const source = profileAgentTemplate(id);
  return decodeProfileAgentSource(targetPath, source).pipe(
    Effect.flatMap((agent) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(agentsPath, { recursive: true });
          const status = await lstat(agentsPath);
          if (status.isSymbolicLink() || !status.isDirectory()) {
            throw new Error("Profile agents root must be a physical directory");
          }
          await writeFile(targetPath, source, { encoding: "utf8", flag: "wx" });
        },
        catch: (cause) => fsError("create", targetPath, cause),
      }).pipe(Effect.as({ agent, path: targetPath })),
    ),
  );
};

export const readProfileAgent = (
  profilePath: string,
  id: string,
): Effect.Effect<
  { readonly agent: ProfileAgent; readonly path: string; readonly source: string },
  ProfileAgentInvalid | ProfileFileSystemError
> => {
  const agentsPath = path.join(profilePath, "agents");
  const targetPath = path.join(profilePath, "agents", `${id}.md`);
  return Effect.all([inspect(profilePath), inspect(agentsPath), inspect(targetPath)]).pipe(
    Effect.flatMap(([profileStatus, agentsStatus, status]) => {
      if (profileStatus.isSymbolicLink() || !profileStatus.isDirectory()) {
        return Effect.fail(
          invalid(profilePath, `Profile root is not a physical directory: ${profilePath}`),
        );
      }
      if (agentsStatus.isSymbolicLink() || !agentsStatus.isDirectory()) {
        return Effect.fail(
          invalid(agentsPath, `Profile agents root is not a physical directory: ${agentsPath}`),
        );
      }
      if (status.isSymbolicLink() || !status.isFile()) {
        return Effect.fail(
          invalid(targetPath, `Profile agent is not a physical file: ${targetPath}`),
        );
      }
      return readText(targetPath).pipe(
        Effect.flatMap((source) =>
          decodeProfileAgentSource(targetPath, source).pipe(
            Effect.map((agent) => ({ agent, path: targetPath, source })),
          ),
        ),
      );
    }),
  );
};

export const replaceProfileAgentFile = (
  profilePath: string,
  id: string,
  expectedSource: string,
  source: string,
): Effect.Effect<
  { readonly agent: ProfileAgent; readonly path: string; readonly source: string },
  ProfileAgentEditConflict | ProfileAgentInvalid | ProfileFileSystemError
> => {
  const targetPath = path.join(profilePath, "agents", `${id}.md`);
  return editLock(targetPath).withPermit(
    Effect.gen(function* () {
      const current = yield* readProfileAgent(profilePath, id);
      const agent = yield* decodeProfileAgentSource(current.path, source);
      if (current.source !== expectedSource) {
        return yield* new ProfileAgentEditConflict({
          id,
          path: current.path,
          message: `Profile agent ${id} changed after the editor opened; reopen it before saving`,
        });
      }
      if (source === current.source) return { ...current, agent };

      const temporaryPath = `${current.path}.ziggy-edit-${randomUUID()}.tmp`;
      yield* Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            let replaced = false;
            try {
              const [profileStatus, agentsStatus, fileStatus] = await Promise.all([
                lstat(profilePath),
                lstat(path.join(profilePath, "agents")),
                lstat(current.path),
              ]);
              if (profileStatus.isSymbolicLink() || !profileStatus.isDirectory()) {
                throw new Error(`${profilePath} must remain a physical directory`);
              }
              if (agentsStatus.isSymbolicLink() || !agentsStatus.isDirectory()) {
                throw new Error(
                  `${path.join(profilePath, "agents")} must remain a physical directory`,
                );
              }
              if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) {
                throw new Error(`${current.path} must remain a physical file`);
              }
              const actualSource = await readPhysicalText(current.path);
              if (actualSource !== expectedSource) {
                throw new ProfileAgentEditConflict({
                  id,
                  path: current.path,
                  message: `Profile agent ${id} changed while it was being saved; reopen it before retrying`,
                });
              }
              await writeFile(temporaryPath, source, {
                encoding: "utf8",
                flag: "wx",
                mode: fileStatus.mode,
              });
              await rename(temporaryPath, current.path);
              replaced = true;
            } finally {
              if (!replaced) await rm(temporaryPath, { force: true });
            }
          },
          catch: (cause) =>
            cause instanceof ProfileAgentEditConflict
              ? cause
              : fsError("save", current.path, cause),
        }),
      );
      return { agent, path: current.path, source };
    }),
  );
};
