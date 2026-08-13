import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Predicate, Schema } from "effect";
import { ProfileAgent, ProfileAgentInvalid, ProfileFileSystemError } from "../../domain/profile";
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

const readText = (targetPath: string) =>
  Effect.tryPromise({
    try: (signal) => readFile(targetPath, { encoding: "utf8", signal }),
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

const rawAgent = (
  id: string,
  fields: ReadonlyMap<string, string>,
  body: string,
): ProfileAgentDecodeInput => ({
  id,
  version: fields.get("version") === "1" ? 1 : fields.get("version"),
  description: fields.get("description"),
  body,
  ...Object.fromEntries([
    ...(["provider", "model", "thinking"] as const).flatMap((name) => {
      const value = fields.get(name);
      return value === undefined ? [] : [[name, value] as const];
    }),
    (() => {
      const tools = fields.get("tools");
      return tools === undefined
        ? []
        : [["tools", tools.split(",").map((tool) => tool.trim())] as const];
    })(),
  ]),
});

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
  { readonly agent: ProfileAgent; readonly path: string },
  ProfileAgentInvalid | ProfileFileSystemError
> => {
  const targetPath = path.join(profilePath, "agents", `${id}.md`);
  return inspect(targetPath).pipe(
    Effect.flatMap((status) => {
      if (status.isSymbolicLink() || !status.isFile()) {
        return Effect.fail(
          invalid(targetPath, `Profile agent is not a physical file: ${targetPath}`),
        );
      }
      return readText(targetPath).pipe(
        Effect.flatMap((source) => decodeProfileAgentSource(targetPath, source)),
        Effect.map((agent) => ({ agent, path: targetPath })),
      );
    }),
  );
};
