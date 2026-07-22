import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { decodeProfileConfig, type ProfileConfigError } from "./profile-config.ts";

export type VoiceName = "clear" | "warm" | "operator";

export const voiceNames: ReadonlyArray<VoiceName> = ["clear", "warm", "operator"];

export const voiceTemplates: Readonly<Record<VoiceName, string>> = {
  clear: `# SOUL.md

## Persona Summary

You are a clear, grounded general assistant. Understand the request, surface important constraints, and help the owner reach a sound result without adding ceremony.

## Tone Directives

Use calm, plain language. Be candid about uncertainty, keep reasoning easy to inspect, and avoid performative enthusiasm.

## Default Verbosity

Be concise by default. Add detail only when it changes a decision, prevents a mistake, or the owner asks for a deeper explanation.
`,
  warm: `# SOUL.md

## Persona Summary

You are an attentive personal assistant who combines practical follow-through with human warmth. Notice context, reduce friction, and make the owner feel supported without becoming intrusive.

## Tone Directives

Write naturally and with gentle warmth. Acknowledge emotion when it matters, offer encouraging clarity, and never use forced cheerfulness or empty reassurance.

## Default Verbosity

Use a conversational amount of detail. Include enough context to make the next step feel easy, while keeping routine answers compact.
`,
  operator: `# SOUL.md

## Persona Summary

You are a decisive engineering operator. Turn ambiguous technical work into explicit constraints, executable actions, and verified outcomes while protecting the owner's systems and data.

## Tone Directives

Be direct, precise, and evidence-led. Lead with the result or blocker, name tradeoffs without hedging, and treat errors as concrete facts to diagnose.

## Default Verbosity

Prefer terse operational updates and dense technical handoffs. Expand only for architecture, risk, debugging evidence, or a decision that needs review.
`,
};

export const profileConfigText = `${JSON.stringify(
  {
    schemaVersion: 1,
    defaultProvider: "anthropic",
    defaultModel: "claude-fable-5",
    thinkingLevel: "medium",
    cacheRetention: "long",
  },
  null,
  2,
)}\n`;

export type ProfileInitializationPoint =
  | "."
  | "automations/"
  | "credentials/"
  | "extensions/"
  | "memory/"
  | "sessions/"
  | "SOUL.md"
  | "ziggy.jsonc";

export class ProfileInitializationError extends Schema.TaggedErrorClass<ProfileInitializationError>()(
  "ProfileInitializationError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class UnknownVoiceError extends Schema.TaggedErrorClass<UnknownVoiceError>()(
  "UnknownVoiceError",
  { voice: Schema.String },
) {
  override get message(): string {
    return `unknown Voice ${JSON.stringify(this.voice)}; expected clear, warm, or operator`;
  }
}

export interface ProfileInitializationRequest {
  readonly profilePath: string;
  readonly voice?: string;
  readonly onBeforeCreate?: (
    point: ProfileInitializationPoint,
  ) => Effect.Effect<void, ProfileInitializationError>;
}

export interface ProfileInitializationResult {
  readonly schemaVersion: 1;
  readonly profilePath: string;
  readonly voice: VoiceName;
  readonly created: ReadonlyArray<ProfileInitializationPoint>;
}

type ScaffoldEntry =
  | {
      readonly point: ProfileInitializationPoint;
      readonly name: string;
      readonly kind: "directory";
    }
  | {
      readonly point: ProfileInitializationPoint;
      readonly name: string;
      readonly kind: "file";
      readonly content: string;
    };

const scaffoldEntries: ReadonlyArray<ScaffoldEntry> = [
  { point: "ziggy.jsonc", name: "ziggy.jsonc", kind: "file", content: profileConfigText },
  { point: "automations/", name: "automations", kind: "directory" },
  { point: "credentials/", name: "credentials", kind: "directory" },
  { point: "extensions/", name: "extensions", kind: "directory" },
  { point: "memory/", name: "memory", kind: "directory" },
  { point: "sessions/", name: "sessions", kind: "directory" },
  { point: "SOUL.md", name: "SOUL.md", kind: "file", content: voiceTemplates.clear },
];

export type ProfileInitializationFailure =
  | ProfileConfigError
  | ProfileInitializationError
  | UnknownVoiceError;

export function initializeProfile(
  request: ProfileInitializationRequest,
): Effect.Effect<ProfileInitializationResult, ProfileInitializationFailure> {
  return Effect.gen(function* () {
    const voice = yield* requireVoice(request.voice ?? "clear");
    const profilePath = yield* canonicalizeProfilePath(request.profilePath);
    const entries = scaffoldEntries.map(
      (entry): ScaffoldEntry =>
        entry.name === "SOUL.md"
          ? { point: entry.point, name: entry.name, kind: "file", content: voiceTemplates[voice] }
          : entry,
    );

    yield* requireSafeParent(profilePath);
    const root = yield* safeLstat(profilePath);
    if (root !== undefined) {
      yield* requireDirectory(root, profilePath);
      yield* preflightEntries(profilePath, entries);
    }

    const created: ProfileInitializationPoint[] = [];
    if (yield* createDirectory(profilePath, ".", request.onBeforeCreate)) created.push(".");
    for (const entry of entries) {
      const path = join(profilePath, entry.name);
      const didCreate =
        entry.kind === "directory"
          ? yield* createDirectory(path, entry.point, request.onBeforeCreate)
          : yield* createFile(
              path,
              entry.content,
              entry.point,
              request.onBeforeCreate,
              entry.name === "ziggy.jsonc" ? validateExistingProfileConfig : undefined,
            );
      if (didCreate) created.push(entry.point);
    }

    return { schemaVersion: 1, profilePath, voice, created };
  });
}

export function isVoiceName(value: string): value is VoiceName {
  return value === "clear" || value === "warm" || value === "operator";
}

function requireVoice(value: string): Effect.Effect<VoiceName, UnknownVoiceError> {
  return isVoiceName(value)
    ? Effect.succeed(value)
    : Effect.fail(new UnknownVoiceError({ voice: value }));
}

function resolveProfilePath(value: string): Effect.Effect<string, ProfileInitializationError> {
  if (value.length === 0 || value.includes("\0")) {
    return Effect.fail(
      new ProfileInitializationError({
        operation: "resolve",
        path: value,
        message: "Profile path must be non-empty and contain no NUL bytes",
      }),
    );
  }
  if (isAbsolute(value)) return Effect.succeed(resolve(value));
  return Effect.try({
    try: () => resolve(process.cwd(), value),
    catch: (cause) =>
      new ProfileInitializationError({
        operation: "resolve",
        path: value,
        message: `failed to resolve Profile path ${value}`,
        cause,
      }),
  });
}

function canonicalizeProfilePath(value: string): Effect.Effect<string, ProfileInitializationError> {
  return Effect.gen(function* () {
    const requested = yield* resolveProfilePath(value);
    const requestedParent = dirname(requested);
    const canonicalParent = yield* tryNode("canonicalize", requestedParent, () =>
      realpath(requestedParent),
    ).pipe(
      Effect.catch((error) =>
        hasErrorCode(error.cause, "ENOENT")
          ? Effect.fail(
              new ProfileInitializationError({
                operation: "canonicalize",
                path: requestedParent,
                message: `Profile parent directory does not exist: ${requestedParent}`,
                cause: error.cause,
              }),
            )
          : Effect.fail(error),
      ),
    );
    const status = yield* safeLstat(canonicalParent);
    if (status === undefined) {
      return yield* new ProfileInitializationError({
        operation: "inspect",
        path: canonicalParent,
        message: `Profile parent directory does not exist: ${requestedParent}`,
      });
    }
    yield* requireDirectory(status, canonicalParent);
    const profilePath = join(canonicalParent, basename(requested));
    const profileStatus = yield* safeLstat(profilePath);
    if (profileStatus === undefined) return profilePath;
    if (profileStatus.isSymbolicLink()) {
      return yield* new ProfileInitializationError({
        operation: "canonicalize",
        path: profilePath,
        message: `refusing symbolic link at ${profilePath}`,
      });
    }
    return yield* tryNode("canonicalize", profilePath, () => realpath(profilePath));
  });
}

function requireSafeParent(path: string): Effect.Effect<void, ProfileInitializationError> {
  const parent = dirname(path);
  return Effect.gen(function* () {
    const status = yield* safeLstat(parent);
    if (status === undefined) {
      return yield* new ProfileInitializationError({
        operation: "inspect",
        path: parent,
        message: `Profile parent directory does not exist: ${parent}`,
      });
    }
    yield* requireDirectory(status, parent);
  });
}

function preflightEntries(
  profilePath: string,
  entries: ReadonlyArray<ScaffoldEntry>,
): Effect.Effect<void, ProfileConfigError | ProfileInitializationError> {
  return Effect.gen(function* () {
    let existingConfigPath: string | undefined;
    for (const entry of entries) {
      const path = join(profilePath, entry.name);
      const status = yield* safeLstat(path);
      if (status === undefined) continue;
      if (entry.kind === "directory") yield* requireDirectory(status, path);
      else yield* requireFile(status, path);
      if (entry.name === "ziggy.jsonc") existingConfigPath = path;
    }
    if (existingConfigPath !== undefined) yield* validateExistingProfileConfig(existingConfigPath);
  });
}

function validateExistingProfileConfig(
  path: string,
): Effect.Effect<void, ProfileConfigError | ProfileInitializationError> {
  return Effect.acquireUseRelease(
    tryNode("open", path, () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
    (handle) =>
      Effect.gen(function* () {
        yield* requireFile(yield* tryNode("inspect", path, () => handle.stat()), path);
        const contents = yield* tryNode("read", path, () => handle.readFile("utf8"));
        yield* decodeProfileConfig(contents, path);
      }),
    (handle) => tryNode("close", path, () => handle.close()),
  );
}

function createDirectory(
  path: string,
  point: ProfileInitializationPoint,
  onBeforeCreate: ProfileInitializationRequest["onBeforeCreate"],
): Effect.Effect<boolean, ProfileInitializationError> {
  return Effect.gen(function* () {
    const existing = yield* safeLstat(path);
    if (existing !== undefined) {
      yield* requireDirectory(existing, path);
      return false;
    }
    if (onBeforeCreate !== undefined) yield* onBeforeCreate(point);
    yield* requireSafeParent(path);
    const created = yield* tryNode("create directory", path, () =>
      mkdir(path, { mode: 0o700 }),
    ).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        hasErrorCode(error.cause, "EEXIST")
          ? safeLstat(path).pipe(
              Effect.flatMap((status) =>
                status === undefined
                  ? Effect.fail(error)
                  : requireDirectory(status, path).pipe(Effect.as(false)),
              ),
            )
          : Effect.fail(error),
      ),
    );
    if (created) yield* tryNode("set permissions", path, () => chmod(path, 0o700));
    return created;
  });
}

type ExistingFileValidator = (
  path: string,
) => Effect.Effect<void, ProfileConfigError | ProfileInitializationError>;

function createFile(
  path: string,
  content: string,
  point: ProfileInitializationPoint,
  onBeforeCreate: ProfileInitializationRequest["onBeforeCreate"],
  validateExisting?: ExistingFileValidator,
): Effect.Effect<boolean, ProfileConfigError | ProfileInitializationError> {
  return Effect.gen(function* () {
    const existing = yield* safeLstat(path);
    if (existing !== undefined) {
      yield* requireFile(existing, path);
      if (validateExisting !== undefined) yield* validateExisting(path);
      return false;
    }
    if (onBeforeCreate !== undefined) yield* onBeforeCreate(point);
    yield* requireSafeParent(path);
    const temporaryPath = yield* Effect.try({
      try: () => join(dirname(path), `.ziggy-init-${process.pid}-${randomUUID()}`),
      catch: (cause) =>
        new ProfileInitializationError({
          operation: "create temporary path",
          path,
          message: `failed to create temporary path for ${path}`,
          cause,
        }),
    });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(temporaryPath),
      (temporary) =>
        Effect.acquireUseRelease(
          tryNode("create temporary file", temporary, () =>
            open(
              temporary,
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
              0o600,
            ),
          ),
          (handle) =>
            Effect.gen(function* () {
              yield* tryNode("set permissions", temporary, () => handle.chmod(0o600));
              yield* tryNode("write", temporary, () => handle.writeFile(content, "utf8"));
              yield* tryNode("sync", temporary, () => handle.sync());
            }),
          (handle) => tryNode("close", temporary, () => handle.close()),
        ).pipe(
          Effect.andThen(
            tryNode("link", path, () => link(temporary, path)).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                hasErrorCode(error.cause, "EEXIST")
                  ? safeLstat(path).pipe(
                      Effect.flatMap((status) =>
                        status === undefined
                          ? Effect.fail(error)
                          : requireFile(status, path).pipe(
                              Effect.andThen(
                                validateExisting === undefined
                                  ? Effect.void
                                  : validateExisting(path),
                              ),
                              Effect.as(false),
                            ),
                      ),
                    )
                  : Effect.fail(error),
              ),
            ),
          ),
        ),
      (temporary) =>
        tryNode("remove temporary file", temporary, () => rm(temporary, { force: true })),
    );
  });
}

function requireDirectory(
  status: Stats,
  path: string,
): Effect.Effect<void, ProfileInitializationError> {
  if (status.isSymbolicLink()) {
    return Effect.fail(
      new ProfileInitializationError({
        operation: "inspect",
        path,
        message: `refusing symbolic link at ${path}`,
      }),
    );
  }
  if (!status.isDirectory()) {
    return Effect.fail(
      new ProfileInitializationError({
        operation: "inspect",
        path,
        message: `expected directory at ${path}`,
      }),
    );
  }
  return Effect.void;
}

function requireFile(status: Stats, path: string): Effect.Effect<void, ProfileInitializationError> {
  if (status.isSymbolicLink()) {
    return Effect.fail(
      new ProfileInitializationError({
        operation: "inspect",
        path,
        message: `refusing symbolic link at ${path}`,
      }),
    );
  }
  if (!status.isFile()) {
    return Effect.fail(
      new ProfileInitializationError({
        operation: "inspect",
        path,
        message: `expected regular file at ${path}`,
      }),
    );
  }
  return Effect.void;
}

function safeLstat(path: string): Effect.Effect<Stats | undefined, ProfileInitializationError> {
  return tryNode("inspect", path, () => lstat(path)).pipe(
    Effect.catch((error) =>
      hasErrorCode(error.cause, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
}

function tryNode<A>(
  operation: string,
  path: string,
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: raw Node filesystem APIs are wrapped immediately below.
  run: () => Promise<A>,
): Effect.Effect<A, ProfileInitializationError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ProfileInitializationError({
        operation,
        path,
        message: `failed to ${operation} ${path}`,
        cause,
      }),
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  // oxlint-disable-next-line ziggy-effect/no-unknown-shape-probing -- boundary: Node system errors expose a stable code field.
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
