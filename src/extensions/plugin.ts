import { lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { Effect, Predicate, Schema } from "effect";
import { bundledPackageMetadata } from "../catalog";
import type { ProfileExtensionInvalid } from "../domain/profile";
import type { ProfileFileSystemError } from "../profile";
import { fsError, invalid, packageExists, parseFrontmatter } from "./package";
import { PLUGIN_SECRET_SERVICE, type PluginSecretsApi } from "./secrets";
import { ExtensionId, type ExtensionPackage } from "./types";

// Agent Plugins 1.0.0 (https://agent-plugins.org): plugin.json, skills/ and mcp.json.

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const PluginName = Schema.String.check(
  Schema.isPattern(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u),
);

const Manifest = Schema.Struct({
  $schema: Schema.Literal(PLUGIN_SCHEMA),
  name: PluginName,
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      email: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  ),
  homepage: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  license: Schema.optionalKey(Schema.String),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  // Namespaces Ziggy does not implement are ignored without validating their values.
  extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const MANIFEST_FIELDS = new Set(Object.keys(Manifest.fields));

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

const decodeObject = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject));

const decodeManifest = Schema.decodeUnknownEffect(Manifest);

const McpFile = Schema.Struct({
  $schema: Schema.Literal(MCP_SCHEMA),
  mcpServers: JsonObject,
});

const decodeMcpFile = Schema.decodeUnknownEffect(Schema.fromJsonString(McpFile));

const StringMap = Schema.Record(Schema.String, Schema.String);

const StdioServer = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: Schema.NonEmptyString,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(StringMap),
  cwd: Schema.optionalKey(Schema.String),
});

const RemoteServer = Schema.Struct({
  type: Schema.Literals(["streamable-http", "sse"]),
  url: Schema.String,
  headers: Schema.optionalKey(StringMap),
});

const decodeServer = Schema.decodeUnknownEffect(Schema.Union([StdioServer, RemoteServer]));

const strict = { onExcessProperty: "error" } as const;

const isExtensionId = Schema.is(ExtensionId);

/** A plugin a Profile selected: its id (folder name) and folder. */
export interface PluginRef {
  readonly id: string;
  readonly root: string;
}

/** A package plus what was reported and ignored while reading it. */
export interface PluginRead {
  readonly package: ExtensionPackage;
  readonly warnings: ReadonlyArray<string>;
}

/** Server config in Pi's shape: values that Pi resolves are already escaped for it. */
export type PluginServerConfig =
  | {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
    }
  | {
      readonly type: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export interface PluginServer {
  readonly name: string;
  readonly plugin: string;
  readonly config: PluginServerConfig;
}

/** The servers selected plugins contribute to one session. */
export interface PluginMcp {
  readonly servers: ReadonlyArray<PluginServer>;
  /** Every `${NAME}` value substituted into a server, for the result redactor. */
  readonly secrets: ReadonlyArray<string>;
  /** Value-free diagnostics: skipped servers and plugins whose MCP is disabled. */
  readonly errors: ReadonlyArray<string>;
}

export const pluginPath = (owner: string, id: string) => path.join(owner, "plugins", id);

/** A filesystem call failed; callers turn it into a Profile error or a diagnostic. */
class PluginIoFailed extends Schema.TaggedErrorClass<PluginIoFailed>()("PluginIoFailed", {
  cause: Schema.Defect(),
}) {}

// oxlint-disable-next-line ziggy-effect/no-native-promise-ownership -- the one node:fs Promise boundary for plugin folders.
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new PluginIoFailed({ cause }) });

/** The file's text, or undefined when it is not a regular file. */
const regularFileText = (file: string) =>
  attempt(() => stat(file)).pipe(
    Effect.flatMap((status) =>
      status.isFile() ? attempt(() => readFile(file, "utf8")) : Effect.succeed(undefined),
    ),
  );

const missing = ({ cause }: PluginIoFailed) => {
  const code =
    Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : undefined;

  return code === "ENOENT" || code === "ENOTDIR";
};

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);

  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/** Whether `<owner>/plugins/<id>/plugin.json` exists at all, valid or not. */
export const pluginExists = (
  owner: string,
  id: string,
): Effect.Effect<boolean, ProfileFileSystemError> => {
  const manifestPath = path.join(pluginPath(owner, id), "plugin.json");

  return attempt(() => lstat(manifestPath)).pipe(
    Effect.as(true),
    Effect.catch((failure) =>
      missing(failure)
        ? Effect.succeed(false)
        : Effect.fail(fsError("inspect", manifestPath, failure.cause)),
    ),
  );
};

interface Skills {
  readonly skillPaths: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Pi's Agent Skills checks (`core/skills.js` validateName/validateDescription). Pi reports a
 * failure as a diagnostic that drops the whole plugin, so a failing skill is skipped here instead.
 */
const skillProblem = (skill: { readonly name: string; readonly description: string }) =>
  skill.name.length > 64
    ? "name exceeds 64 characters"
    : !/^[a-z0-9-]+$/u.test(skill.name)
      ? "name must use lowercase a-z, 0-9 and hyphens only"
      : skill.name.startsWith("-") || skill.name.endsWith("-")
        ? "name must not start or end with a hyphen"
        : skill.name.includes("--")
          ? "name must not contain consecutive hyphens"
          : skill.description.trim() === ""
            ? "description is required"
            : skill.description.length > 1024
              ? "description exceeds 1024 characters"
              : undefined;

/** One `skills/<name>/SKILL.md`: a regular file inside the plugin with valid frontmatter. */
const readSkill = (id: string, physicalRoot: string, skillsPath: string, name: string) =>
  Effect.gen(function* () {
    const file = path.join(skillsPath, name, "SKILL.md");
    const skipped = (reason: string) => ({ warning: `plugin ${id}: skill '${name}' ${reason}` });
    const physical = yield* Effect.result(attempt(() => realpath(file)));

    if (physical._tag === "Failure")
      return missing(physical.failure) ? undefined : skipped("could not be read");

    if (!inside(physicalRoot, physical.success)) return skipped("resolves outside the plugin");

    const text = yield* Effect.result(regularFileText(file));

    if (text._tag === "Failure") return skipped("could not be read");

    if (text.success === undefined) return skipped("SKILL.md is not a regular file");

    const skill = parseFrontmatter(text.success);

    if (skill === undefined) return skipped("has invalid frontmatter");

    const problem = skillProblem(skill);

    return problem === undefined ? { file, skill } : skipped(`skipped: ${problem}`);
  });

/** Each immediate child of `skills/` holding a SKILL.md; bad skills are reported and skipped. */
const discoverSkills = (id: string, root: string, physicalRoot: string) =>
  Effect.gen(function* () {
    const skillsPath = path.join(root, "skills");
    const none: Skills = { skillPaths: [], skills: [], warnings: [] };

    const invalidSkills = (reason: string): Skills => ({
      ...none,
      warnings: [`plugin ${id}: skills/ ${reason}; no skills loaded`],
    });

    const physical = yield* Effect.result(attempt(() => realpath(skillsPath)));

    if (physical._tag === "Failure")
      return missing(physical.failure) ? none : invalidSkills("could not be read");

    if (!inside(physicalRoot, physical.success))
      return invalidSkills("resolves outside the plugin");

    const entries = yield* Effect.result(
      attempt(() => stat(skillsPath)).pipe(
        Effect.flatMap((status) =>
          status.isDirectory()
            ? attempt(() => readdir(skillsPath)).pipe(Effect.map((names) => names.toSorted()))
            : Effect.succeed(undefined),
        ),
      ),
    );

    if (entries._tag === "Failure") return invalidSkills("could not be read");

    if (entries.success === undefined) return invalidSkills("is not a directory");

    const found = yield* Effect.forEach(entries.success, (name) =>
      readSkill(id, physicalRoot, skillsPath, name),
    );

    return found.reduce<Skills>(
      (all, item) =>
        item === undefined
          ? all
          : "warning" in item
            ? { ...all, warnings: [...all.warnings, item.warning] }
            : {
                ...all,
                skillPaths: [...all.skillPaths, item.file],
                skills: [...all.skills, item.skill],
              },
      none,
    );
  });

/**
 * Read and check the plugin at `<owner>/plugins/<id>`. A schema violation rejects it; unknown
 * manifest fields, a non-object `extensions` and invalid skills are reported and ignored.
 * Only `plugin.json` and `skills/` are read here; `mcp.json` is read when a session opens.
 */
export const readPluginPackage = (
  owner: string,
  id: string,
): Effect.Effect<PluginRead, ProfileExtensionInvalid | ProfileFileSystemError> =>
  Effect.gen(function* () {
    const root = pluginPath(owner, id);
    const manifestPath = path.join(root, "plugin.json");

    if (!isExtensionId(id)) {
      return yield* invalid(root, `plugin folder name must use lowercase kebab-case: '${id}'`);
    }

    const rootStatus = yield* attempt(() => lstat(root)).pipe(
      Effect.mapError((failure) =>
        missing(failure)
          ? invalid(root, `unknown plugin '${id}'`)
          : fsError("inspect", root, failure.cause),
      ),
    );

    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      return yield* invalid(root, `plugin '${id}' is not a physical directory`);
    }

    const physicalRoot = yield* attempt(() => realpath(root)).pipe(
      Effect.mapError((failure) => fsError("resolve", root, failure.cause)),
    );

    const physicalManifest = yield* attempt(() => realpath(manifestPath)).pipe(
      Effect.mapError((failure) =>
        missing(failure)
          ? invalid(manifestPath, `plugin '${id}' has no plugin.json`)
          : fsError("resolve", manifestPath, failure.cause),
      ),
    );

    if (!inside(physicalRoot, physicalManifest)) {
      return yield* invalid(manifestPath, `plugin '${id}' plugin.json resolves outside the plugin`);
    }

    const text = yield* regularFileText(manifestPath).pipe(
      Effect.mapError((failure) => fsError("read", manifestPath, failure.cause)),
    );

    if (text === undefined) {
      return yield* invalid(manifestPath, `plugin '${id}' plugin.json is not a regular file`);
    }

    const raw = yield* decodeObject(text).pipe(
      Effect.mapError((cause) =>
        invalid(manifestPath, `invalid plugin manifest: ${manifestPath}`, cause),
      ),
    );

    // Unknown fields and a non-object `extensions` are reported and ignored (spec 1.0.0).
    const warnings = Object.entries(raw).flatMap(([field, value]) =>
      !MANIFEST_FIELDS.has(field)
        ? [`plugin ${id}: unknown plugin.json field ${JSON.stringify(field)} ignored`]
        : field === "extensions" && !Predicate.isObject(value)
          ? [`plugin ${id}: plugin.json "extensions" is not an object; ignored`]
          : [],
    );

    const known = Object.fromEntries(
      Object.entries(raw).filter(
        ([field, value]) =>
          MANIFEST_FIELDS.has(field) && (field !== "extensions" || Predicate.isObject(value)),
      ),
    );

    const manifest = yield* decodeManifest(known, strict).pipe(
      Effect.mapError((cause) =>
        invalid(
          manifestPath,
          `invalid plugin manifest (Agent Plugins 1.0.0): ${manifestPath}`,
          cause,
        ),
      ),
    );

    const skills = yield* discoverSkills(id, root, physicalRoot);
    const description = (manifest.description ?? "").replace(/\s+/gu, " ").trim();

    return {
      package: {
        id,
        description: description === "" ? manifest.name : description,
        packagePath: root,
        extensionPaths: [],
        skillPaths: skills.skillPaths,
        skills: skills.skills,
        automations: [],
        kind: "plugin",
        required: false,
      },
      warnings: [...warnings, ...skills.warnings],
    };
  });

/** The plugin ids under `<owner>/plugins/` that hold a `plugin.json`. */
const pluginIds = (owner: string): Effect.Effect<ReadonlyArray<string>, ProfileFileSystemError> => {
  const shelf = path.join(owner, "plugins");

  return attempt(() => readdir(shelf, { withFileTypes: true })).pipe(
    Effect.catch((failure) =>
      missing(failure) ? Effect.succeed([]) : Effect.fail(fsError("list", shelf, failure.cause)),
    ),
    Effect.map((entries) =>
      entries.filter((entry) => entry.isDirectory() && isExtensionId(entry.name)),
    ),
    Effect.flatMap((entries) => Effect.filter(entries, (entry) => pluginExists(owner, entry.name))),
    Effect.map((entries) => entries.map((entry) => entry.name).sort()),
  );
};

/**
 * An extension owns its id: `plugins/<id>` is ignored when `extensions/<id>` exists or `<id>` is
 * a bundled extension. Session open, listing and `show` all apply this rule; `add` refuses it.
 */
export const pluginShadowed = (
  owner: string,
  id: string,
): Effect.Effect<boolean, ProfileFileSystemError> =>
  bundledPackageMetadata(id) === undefined ? packageExists(owner, id) : Effect.succeed(true);

export const shadowedWarning = (id: string) =>
  `plugins/${id} is ignored: the extension '${id}' owns that id; rename the plugin folder`;

/**
 * The plugins a Profile can offer. A plugin that an extension shadows, or that cannot be read,
 * is logged and left out, so one broken folder never hides the rest. Selected plugins are read
 * strictly when a session opens.
 */
export const scanPlugins = (
  owner: string,
): Effect.Effect<ReadonlyArray<ExtensionPackage>, ProfileFileSystemError> =>
  Effect.flatMap(pluginIds(owner), (ids) =>
    Effect.map(
      Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          if (yield* pluginShadowed(owner, id)) {
            yield* Effect.logWarning(shadowedWarning(id));

            return [];
          }

          const read = yield* Effect.result(readPluginPackage(owner, id));

          if (read._tag === "Success") return [read.success.package];

          yield* Effect.logWarning(`plugins/${id} is not listed: ${read.failure.message}`);

          return [];
        }),
      ),
      (found) => found.flat(),
    ),
  );

// MCP servers. Every diagnostic below names fields and variables, never values.

type SecretLookup = Pick<PluginSecretsApi, "get">;

const SERVER_KEY = /^[A-Za-z0-9_-]+$/u;

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

const RESERVED = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

type Built = { readonly config: PluginServerConfig; readonly secrets: ReadonlyArray<string> };

type Outcome = Built | { readonly skip: string };

const skip = (reason: string): Outcome => ({ skip: reason });

/** Single-pass, non-recursive: replaced text is never scanned again. */
const substitute = (value: string, values: ReadonlyMap<string, string>) =>
  value.replace(VARIABLE, (match, name: string) => values.get(name) ?? match);

const referenced = (values: ReadonlyArray<string>) => [
  ...new Set(
    values.flatMap((value) =>
      [...value.matchAll(VARIABLE)].flatMap((match) =>
        match[1] === undefined || RESERVED.has(match[1]) ? [] : [match[1]],
      ),
    ),
  ),
];

/** Pi resolves `$NAME` and `!command` in env and header values; make every value literal. */
const literalForPi = (value: string) =>
  value.replace(/\$/gu, () => "$$").replace(/^!/u, () => "$!");

const literalMap = (values: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, literalForPi(value)]));

/** `${NAME}` from the Keychain first, then the environment. */
const resolveVariables = (secrets: SecretLookup, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const values = new Map<string, string>();

    for (const name of names) {
      const stored = yield* Effect.result(secrets.get(name));

      if (stored._tag === "Failure") {
        return { missing: `\${${name}} could not be read from the Keychain` } as const;
      }

      const value = stored.success ?? process.env[name];

      if (value === undefined || value === "") {
        return {
          missing: `\${${name}} is not set (Keychain service ${PLUGIN_SECRET_SERVICE} or environment)`,
        } as const;
      }

      values.set(name, value);
    }

    return { values } as const;
  });

const physicalInside = (root: string, target: string) =>
  Effect.map(Effect.result(attempt(() => realpath(target))), (physical) =>
    physical._tag === "Failure" ? missing(physical.failure) : inside(root, physical.success),
  );

const CWD_FORMS = "cwd must be ./…, ${PLUGIN_ROOT}[/…] or ${PLUGIN_DATA}[/…] inside that folder";

interface Folders {
  readonly root: string;
  readonly data: string;
}

const workingDirectory = (cwd: string | undefined, folders: Folders) =>
  Effect.gen(function* () {
    if (cwd === undefined) return folders.root;

    const base =
      cwd.startsWith("./") || cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/")
        ? folders.root
        : cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/")
          ? folders.data
          : undefined;

    if (base === undefined) return undefined;

    const expanded = cwd
      .replace(/^\$\{PLUGIN_ROOT\}/u, () => folders.root)
      .replace(/^\$\{PLUGIN_DATA\}/u, () => folders.data);

    const resolved = path.resolve(folders.root, expanded);

    return inside(base, resolved) && (yield* physicalInside(base, resolved)) ? resolved : undefined;
  });

const stdioServer = (server: typeof StdioServer.Type, folders: Folders, secrets: SecretLookup) =>
  Effect.gen(function* () {
    const env = server.env ?? {};

    if (Object.keys(env).some((name) => RESERVED.has(name))) {
      return skip("env may not define PLUGIN_ROOT or PLUGIN_DATA");
    }

    let command = server.command;

    if (command.startsWith("./")) {
      command = path.resolve(folders.root, command);

      if (!inside(folders.root, command) || !(yield* physicalInside(folders.root, command))) {
        return skip("command resolves outside the plugin");
      }
    } else if (/[/\\]/u.test(command)) {
      return skip("command must be a bare executable name or a ./ path inside the plugin");
    }

    const cwd = yield* workingDirectory(server.cwd, folders);

    if (cwd === undefined) return skip(CWD_FORMS);

    const reserved = new Map([
      ["PLUGIN_ROOT", folders.root],
      ["PLUGIN_DATA", folders.data],
    ]);

    const resolved = yield* resolveVariables(secrets, referenced(Object.values(env)));

    if ("missing" in resolved) return skip(resolved.missing);

    const values = new Map([...resolved.values, ...reserved]);

    return {
      config: {
        command,
        args: (server.args ?? []).map((arg) => substitute(arg, reserved)),
        env: literalMap({
          ...Object.fromEntries(
            Object.entries(env).map(([name, value]) => [name, substitute(value, values)]),
          ),
          PLUGIN_ROOT: folders.root,
          PLUGIN_DATA: folders.data,
        }),
        cwd,
      },
      secrets: [...resolved.values.values()],
    } satisfies Built;
  });

const isLoopback = (host: string) =>
  host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(host);

const URL_RULE =
  "url must be an absolute https URL (http only for loopback) without credentials or fragment";

const validUrl = (value: string) => {
  if (!URL.canParse(value) || value.includes("#")) return false;

  const url = new URL(value);

  return (
    url.username === "" &&
    url.password === "" &&
    (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)))
  );
};

const remoteServer = (server: typeof RemoteServer.Type, secrets: SecretLookup) =>
  Effect.gen(function* () {
    if (server.type === "sse") return skip("transport sse is not supported");

    const headers = server.headers ?? {};
    const names = Object.keys(headers);

    if (names.some((name) => !HEADER_NAME.test(name))) return skip("invalid header name");

    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      return skip("duplicate header names");
    }

    const resolved = yield* resolveVariables(
      secrets,
      referenced([server.url, ...Object.values(headers)]),
    );

    if ("missing" in resolved) return skip(resolved.missing);

    // Values substituted into the url are URI-encoded, so a secret cannot change its structure.
    const url = substitute(
      server.url,
      new Map([...resolved.values].map(([name, value]) => [name, encodeURIComponent(value)])),
    );

    if (!validUrl(url)) {
      return skip(
        url === server.url
          ? URL_RULE
          : `${URL_RULE}; \${NAME} values in the url are URI-encoded, so they cannot supply a scheme, host or port`,
      );
    }

    const values = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, substitute(value, resolved.values)]),
    );

    if (Object.values(values).some((value) => ["\r", "\n", "\0"].some((c) => value.includes(c)))) {
      return skip("header values may not contain line breaks or NUL");
    }

    return {
      config: { type: "http", url, headers: literalMap(values) },
      secrets: [...resolved.values.values()].flatMap((value) => [value, encodeURIComponent(value)]),
    } satisfies Built;
  });

/** `mcp.json` if the plugin has one; a malformed file disables MCP for the plugin. */
const readMcpFile = (plugin: PluginRef, physicalRoot: string) =>
  Effect.gen(function* () {
    const file = path.join(plugin.root, "mcp.json");

    const disabled = (reason: string) =>
      ({ error: `plugin ${plugin.id}: mcp.json ${reason}; MCP disabled` }) as const;

    const physical = yield* Effect.result(attempt(() => realpath(file)));

    if (physical._tag === "Failure")
      return missing(physical.failure) ? undefined : disabled("could not be read");

    if (!inside(physicalRoot, physical.success)) return disabled("resolves outside the plugin");

    const text = yield* Effect.result(regularFileText(file));

    if (text._tag === "Failure") return disabled("could not be read");

    if (text.success === undefined) return disabled("is not a regular file");

    const decoded = yield* Effect.result(decodeMcpFile(text.success, strict));

    return decoded._tag === "Failure"
      ? disabled("is not a valid Agent Plugins 1.0.0 MCP configuration")
      : { servers: decoded.success.mcpServers };
  });

/**
 * `<profile>/plugin-data/<id>/`, created when a session that loads MCP opens and the plugin's
 * `mcp.json` lists at least one server, before any of them is checked or launched.
 */
const dataFolder = (profilePath: string, id: string) =>
  Effect.result(
    attempt(() => mkdir(path.join(profilePath, "plugin-data", id), { recursive: true })).pipe(
      Effect.flatMap(() => attempt(() => realpath(path.join(profilePath, "plugin-data", id)))),
    ),
  );

/**
 * Turn the selected plugins' `mcp.json` files into Pi server entries. Nothing here fails: a bad
 * file, an invalid entry, an unresolved `${NAME}` or a name already in `taken` skips that server
 * with a diagnostic, and the session opens without it. Plugin folders are only read.
 */
export const pluginMcp = (
  profilePath: string,
  plugins: ReadonlyArray<PluginRef>,
  secrets: SecretLookup,
  taken: ReadonlyArray<string> = [],
): Effect.Effect<PluginMcp> =>
  Effect.gen(function* () {
    const used = new Set(taken);
    const servers: PluginServer[] = [];
    const values = new Set<string>();
    const errors: string[] = [];

    for (const plugin of plugins) {
      const physicalRoot = yield* Effect.result(attempt(() => realpath(plugin.root)));

      if (physicalRoot._tag === "Failure") {
        errors.push(`plugin ${plugin.id}: folder could not be read; MCP disabled`);
        continue;
      }

      const file = yield* readMcpFile(plugin, physicalRoot.success);

      if (file === undefined) continue;

      if ("error" in file) {
        errors.push(file.error);
        continue;
      }

      const keys = Object.keys(file.servers);

      if (keys.length === 0) continue;

      const data = yield* dataFolder(profilePath, plugin.id);

      if (data._tag === "Failure") {
        errors.push(`plugin ${plugin.id}: could not create its plugin-data folder; MCP disabled`);
        continue;
      }

      const folders = { root: physicalRoot.success, data: data.success };

      for (const key of keys) {
        const label = `plugin ${plugin.id}: server ${JSON.stringify(key)} skipped`;

        if (!SERVER_KEY.test(key)) {
          errors.push(`${label}: names may use only letters, digits, '_' and '-'`);
          continue;
        }

        const name = keys.length === 1 ? plugin.id : `${plugin.id}_${key}`;
        const decoded = yield* Effect.result(decodeServer(file.servers[key], strict));

        if (decoded._tag === "Failure") {
          errors.push(`${label}: not a valid Agent Plugins 1.0.0 server configuration`);
          continue;
        }

        const server = decoded.success;

        const outcome =
          server.type === "stdio"
            ? yield* stdioServer(server, folders, secrets)
            : yield* remoteServer(server, secrets);

        if ("skip" in outcome) {
          errors.push(`${label}: ${outcome.skip}`);
        } else if (used.has(name)) {
          errors.push(`${label}: server name "${name}" is already in use`);
        } else {
          used.add(name);
          servers.push({ name, plugin: plugin.id, config: outcome.config });

          for (const value of outcome.secrets) values.add(value);
        }
      }
    }

    return { servers, secrets: [...values], errors };
  });
