import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";

const ProfileConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  defaultProvider: Schema.String.check(Schema.isNonEmpty()),
  defaultModel: Schema.String.check(Schema.isNonEmpty()),
  thinkingLevel: Schema.Literals(["low", "medium", "high"]),
  cacheRetention: Schema.Literals(["none", "short", "long"]),
});

export type ProfileConfig = typeof ProfileConfigSchema.Type;

export class ProfileConfigError extends Schema.TaggedErrorClass<ProfileConfigError>()(
  "ProfileConfigError",
  {
    path: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const decodeProfileConfigJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProfileConfigSchema),
  { onExcessProperty: "error" },
);
const decodeJsonString = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.String));

export function loadProfileConfig(
  profilePath: string,
): Effect.Effect<ProfileConfig, ProfileConfigError> {
  const path = join(profilePath, "ziggy.jsonc");
  return Effect.gen(function* () {
    const status = yield* safeLstat(path);
    if (status === undefined || status.isSymbolicLink() || !status.isFile()) {
      return yield* new ProfileConfigError({
        path,
        operation: "inspect",
        message: `expected regular Profile config at ${path}`,
      });
    }
    return yield* Effect.acquireUseRelease(
      tryNode("open", path, () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
      (handle) =>
        tryNode("read", path, () => handle.readFile("utf8")).pipe(
          Effect.flatMap((contents) => decodeProfileConfig(contents, path)),
        ),
      (handle) => tryNode("close", path, () => handle.close()),
    );
  });
}

export function decodeProfileConfig(
  contents: string,
  path: string,
): Effect.Effect<ProfileConfig, ProfileConfigError> {
  return Effect.gen(function* () {
    const stripped = stripJsonComments(contents);
    if (stripped.kind === "unterminated-comment") {
      return yield* new ProfileConfigError({
        path,
        operation: "decode",
        message: `invalid Profile config at ${path}: unterminated block comment`,
      });
    }
    const duplicate = duplicateTopLevelKey(stripped.value);
    if (duplicate !== undefined) {
      return yield* new ProfileConfigError({
        path,
        operation: "decode",
        message: `invalid Profile config at ${path}: duplicate field ${duplicate}`,
      });
    }
    return yield* decodeProfileConfigJson(stripped.value).pipe(
      Effect.mapError(
        (cause) =>
          new ProfileConfigError({
            path,
            operation: "decode",
            message: `invalid Profile config at ${path}`,
            cause,
          }),
      ),
    );
  });
}

function duplicateTopLevelKey(json: string): string | undefined {
  const found = new Set<string>();
  let depth = 0;
  let index = 0;
  let expectingKey = false;
  while (index < json.length) {
    const character = json.charAt(index);
    if (character === "{") {
      depth += 1;
      expectingKey = depth === 1;
      index += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (character === "," && depth === 1) {
      expectingKey = true;
      index += 1;
      continue;
    }
    if (character !== '"') {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    let escaped = false;
    while (index < json.length) {
      const current = json.charAt(index);
      index += 1;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') break;
    }
    if (!expectingKey || depth !== 1) continue;
    const decoded = decodeJsonString(json.slice(start, index));
    if (!Result.isSuccess(decoded)) continue;
    if (found.has(decoded.success)) return decoded.success;
    found.add(decoded.success);
    expectingKey = false;
  }
  return undefined;
}

type StripJsonCommentsResult =
  | { readonly kind: "success"; readonly value: string }
  | { readonly kind: "unterminated-comment" };

function stripJsonComments(contents: string): StripJsonCommentsResult {
  let result = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < contents.length) {
    const character = contents.charAt(index);
    const next = contents.charAt(index + 1);
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      result += "  ";
      index += 2;
      while (
        index < contents.length &&
        contents.charAt(index) !== "\n" &&
        contents.charAt(index) !== "\r"
      ) {
        result += " ";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      result += "  ";
      index += 2;
      let terminated = false;
      while (index < contents.length) {
        const current = contents.charAt(index);
        if (current === "*" && contents.charAt(index + 1) === "/") {
          result += "  ";
          index += 2;
          terminated = true;
          break;
        }
        result += current === "\n" || current === "\r" ? current : " ";
        index += 1;
      }
      if (!terminated) return { kind: "unterminated-comment" };
      continue;
    }
    result += character;
    index += 1;
  }
  return { kind: "success", value: result };
}

function safeLstat(path: string): Effect.Effect<Stats | undefined, ProfileConfigError> {
  return tryNode("inspect", path, () => lstat(path)).pipe(
    Effect.catch((error) =>
      hasCode(error.cause, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );
}

function tryNode<A>(
  operation: string,
  path: string,
  // oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- boundary: raw Node filesystem APIs are wrapped immediately below.
  run: () => Promise<A>,
): Effect.Effect<A, ProfileConfigError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ProfileConfigError({
        path,
        operation,
        message: `failed to ${operation} Profile config at ${path}`,
        cause,
      }),
  });
}

function hasCode(error: unknown, code: string): boolean {
  // oxlint-disable-next-line ziggy-effect/no-unknown-shape-probing -- boundary: Node system errors expose a stable code field.
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
