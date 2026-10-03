// The rules Ziggy applies when it loads a plugin (Agent Plugins 1.0.0 as Ziggy reads it), so
// smoke.ts can fail where Ziggy would skip a server or reject the plugin. It mirrors Ziggy's
// src/extensions/plugin.ts; a test in Ziggy's repository keeps the two in agreement. No
// dependencies: it runs from any Profile. You should not need to edit it.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export interface StdioServer {
  readonly type: "stdio";
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface Checked {
  /** Each one makes Ziggy reject the plugin or skip a server or skill (or breaks a convention). */
  readonly problems: ReadonlyArray<string>;
  /** Ignored by Ziggy with a warning. */
  readonly warnings: ReadonlyArray<string>;
  /** Servers Ziggy skips (with a warning) until a `${NAME}` they use is set. */
  readonly unset: ReadonlyArray<string>;
  /** Valid stdio servers, by mcp.json key, with the name the model sees them under. */
  readonly stdio: ReadonlyArray<{ key: string; name: string; server: StdioServer }>;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u;
const SERVER_KEY = /^[A-Za-z0-9_-]+$/u;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const RESERVED = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MANIFEST_STRINGS = ["version", "description", "homepage", "repository", "license"];
const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "author",
  "keywords",
  "extensions",
  ...MANIFEST_STRINGS,
]);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((item) => typeof item === "string");

const onlyKeys = (value: Json, allowed: ReadonlyArray<string>) =>
  Object.keys(value).every((key) => allowed.includes(key));

const inside = (root: string, target: string) => {
  const path = relative(root, target);

  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** Ziggy's check: a target that does not exist yet passes; one that exists must stay inside. */
const physicallyInside = (root: string, target: string) => {
  try {
    return inside(root, realpathSync(target));
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;

    return code === "ENOENT" || code === "ENOTDIR";
  }
};

const variables = (value: string) => [...value.matchAll(VARIABLE)].map((match) => match[1] ?? "");

/** Looks up a `${NAME}`: Ziggy reads the Keychain (service ziggy-plugin), then the environment. */
export type Secret = (name: string) => string | undefined;

const substitute = (value: string, values: ReadonlyMap<string, string>) =>
  value.replace(VARIABLE, (match, name: string) => values.get(name) ?? match);

/** The `${NAME}` values a server needs, or the first one that is not set. */
const resolveVariables = (values: ReadonlyArray<string>, secret: Secret) => {
  const resolved = new Map<string, string>();

  for (const name of new Set(values.flatMap(variables))) {
    if (RESERVED.has(name)) continue;

    const value = secret(name);

    if (value === undefined || value === "") {
      return { missing: `\${${name}} is not set` };
    }

    resolved.set(name, value);
  }

  return { resolved };
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * A SKILL.md's frontmatter as Pi reads it (pi-coding-agent utils/frontmatter.ts): real YAML.
 * Pi rejects a skill whose YAML does not parse, e.g. an unquoted `description: Use when: …`, or
 * repeats a key (Pi's YAML parser rejects duplicates; Bun's accepts them, so they are checked here).
 */
const piFrontmatter = (
  text: string,
): { name: string; description: string } | { error: string } | undefined => {
  const normalized = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");

  if (!normalized.startsWith("---")) return undefined;

  const end = normalized.indexOf("\n---", 3);

  if (end === -1) return undefined;

  const yaml = normalized.slice(4, end);
  let fields: unknown;

  try {
    fields = Bun.YAML.parse(yaml);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const keys = yaml.split("\n").flatMap((line) => {
    const key = /^([^\s#:][^:]*?)\s*:(?:\s|$)/u.exec(line)?.[1];

    return key === undefined ? [] : [key.replace(/^(["'])(.*)\1$/u, "$2")];
  });
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);

  if (repeated !== undefined) return { error: `Map keys must be unique: "${repeated}"` };

  const name = isObject(fields) ? fields["name"] : undefined;
  const description = isObject(fields) ? fields["description"] : undefined;

  return typeof name === "string" && typeof description === "string"
    ? { name, description }
    : undefined;
};

/**
 * The same frontmatter as Ziggy reads it (src/extensions/package.ts parseFrontmatter): line by
 * line, `key: value` with one pair of surrounding quotes removed. No BOM, and the closing line is
 * exactly `---`. A skill must pass both readers, so keep values on one line and comment-free.
 */
const ziggyFrontmatter = (text: string): { name: string; description: string } | undefined => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);

  if (match === null) return undefined;

  const fields = new Map(
    (match[1] ?? "")
      .split(/\r?\n/u)
      .map((line) => /^([a-zA-Z]+):\s*(.*)$/u.exec(line))
      .flatMap((entry) => (entry === null ? [] : [[entry[1], entry[2]] as const])),
  );

  const scalar = (value: string | undefined) => {
    const trimmed = value?.trim();

    return trimmed !== undefined &&
      trimmed.length >= 2 &&
      ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
  };

  const name = scalar(fields.get("name"));
  const description = scalar(fields.get("description"));

  return name === undefined || description === undefined ? undefined : { name, description };
};

/** Pi's skill name and description rules. */
const skillProblem = (name: string, description: string) =>
  name.length > 64
    ? "name exceeds 64 characters"
    : !/^[a-z0-9-]+$/u.test(name)
      ? "name must use lowercase a-z, 0-9 and hyphens only"
      : name.startsWith("-") || name.endsWith("-")
        ? "name must not start or end with a hyphen"
        : name.includes("--")
          ? "name must not contain consecutive hyphens"
          : description.trim() === ""
            ? "description is required"
            : description.length > 1024
              ? "description exceeds 1024 characters"
              : undefined;

const isLoopback = (host: string) =>
  host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(host);

const validUrl = (value: string) => {
  if (!URL.canParse(value) || value.includes("#")) return false;

  const url = new URL(value);

  return (
    url.username === "" &&
    url.password === "" &&
    (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname)))
  );
};

/** Where a cwd lands, or undefined when Ziggy would skip the server for it. */
export const workingDirectory = (cwd: string | undefined, root: string, data: string) => {
  if (cwd === undefined) return root;

  const base =
    cwd.startsWith("./") || cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/")
      ? root
      : cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/")
        ? data
        : undefined;

  if (base === undefined) return undefined;

  const resolved = resolve(
    root,
    cwd.replace(/^\$\{PLUGIN_ROOT\}/u, () => root).replace(/^\$\{PLUGIN_DATA\}/u, () => data),
  );

  return inside(base, resolved) && physicallyInside(base, resolved) ? resolved : undefined;
};

/** A server's problems, and the first unset `${NAME}` it uses (Ziggy skips it until set). */
interface ServerCheck {
  readonly problems: ReadonlyArray<string>;
  readonly unset?: string;
}

const stdioProblems = (
  server: StdioServer,
  root: string,
  data: string,
  secret: Secret,
): ServerCheck => {
  const problems: string[] = [];
  const env = server.env ?? {};

  if (Object.keys(env).some((name) => RESERVED.has(name))) {
    problems.push("env may not define PLUGIN_ROOT or PLUGIN_DATA");
  }

  if (server.command.startsWith("./")) {
    const command = resolve(root, server.command);

    if (!inside(root, command) || !physicallyInside(root, command)) {
      problems.push("command resolves outside the plugin");
    }
  } else if (/[/\\]/u.test(server.command)) {
    problems.push("command must be a bare executable name or a ./ path inside the plugin");
  }

  if (workingDirectory(server.cwd, root, data) === undefined) {
    problems.push("cwd must be ./…, ${PLUGIN_ROOT}[/…] or ${PLUGIN_DATA}[/…] inside that folder");
  }

  const variables = resolveVariables(Object.values(env), secret);

  // Stricter than Ziggy, which passes these through literally: a secret never goes in argv.
  const literal = [server.command, ...(server.args ?? []), server.cwd ?? ""].flatMap((value) =>
    [...value.matchAll(VARIABLE)].map((match) => match[1] ?? ""),
  );

  if (literal.some((name) => !RESERVED.has(name))) {
    problems.push("${NAME} works only in env (and remote headers/url), never command, args or cwd");
  }

  return "missing" in variables ? { problems, unset: variables.missing } : { problems };
};

const remoteProblems = (server: Json, secret: Secret): ServerCheck => {
  const failed = (problem: string) => ({ problems: [problem] });

  if (server["type"] === "sse") return failed("transport sse is not supported");

  const headers = isStringMap(server["headers"]) ? server["headers"] : {};
  const names = Object.keys(headers);

  if (names.some((name) => !HEADER_NAME.test(name))) return failed("invalid header name");

  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    return failed("duplicate header names");
  }

  const url = String(server["url"]);
  const variables = resolveVariables([url, ...Object.values(headers)], secret);

  if ("missing" in variables) return { problems: [], unset: variables.missing };

  // `${NAME}` values are URI-encoded into the url, so they can never supply scheme, host or port.
  const encoded = new Map(
    [...variables.resolved].map(([name, value]) => [name, encodeURIComponent(value)]),
  );

  if (!validUrl(substitute(url, encoded))) {
    return failed(
      "url must be an absolute https URL (http only for loopback) without credentials or fragment",
    );
  }

  const values = Object.values(headers).map((value) => substitute(value, variables.resolved));

  return values.some((value) => /[\r\n\0]/u.test(value))
    ? failed("header values may not contain line breaks or NUL")
    : { problems: [] };
};

/**
 * Every problem Ziggy would find in `folder` (a `plugins/<id>/` folder) when its servers run
 * with `data` as PLUGIN_DATA. Both folders must exist.
 */
export const checkPlugin = (folder: string, dataFolder: string, secret: Secret): Checked => {
  const id = basename(folder);
  const root = realpathSync(folder);
  const data = realpathSync(dataFolder);
  const problems: string[] = [];
  const warnings: string[] = [];
  const unset: string[] = [];
  const stdio: Array<{ key: string; name: string; server: StdioServer }> = [];

  if (!ID.test(id)) problems.push(`folder name "${id}" must be lowercase kebab-case`);

  // plugin.json: unknown fields are ignored with a warning; known fields are checked strictly.
  const manifest = readJson(resolve(root, "plugin.json"));

  if (!isObject(manifest)) {
    problems.push("plugin.json is missing or not a JSON object");
  } else {
    for (const field of Object.keys(manifest)) {
      if (!MANIFEST_FIELDS.has(field)) warnings.push(`plugin.json field "${field}" is ignored`);
    }

    if (manifest["$schema"] !== PLUGIN_SCHEMA) {
      problems.push(`plugin.json "$schema" must be "${PLUGIN_SCHEMA}"`);
    }

    const name = manifest["name"];

    if (typeof name !== "string" || !PLUGIN_NAME.test(name)) {
      problems.push("plugin.json name must be lowercase letters, digits, '-' and '.'");
    } else if (name !== id) {
      problems.push(`plugin.json name "${name}" should equal the folder name "${id}"`);
    }

    for (const field of MANIFEST_STRINGS) {
      if (field in manifest && typeof manifest[field] !== "string") {
        problems.push(`plugin.json "${field}" must be a string`);
      }
    }

    const author = manifest["author"];

    if (
      author !== undefined &&
      !(
        isObject(author) &&
        onlyKeys(author, ["name", "email", "url"]) &&
        Object.values(author).every((value) => typeof value === "string")
      )
    ) {
      problems.push('plugin.json "author" may hold only string name, email and url');
    }

    if ("keywords" in manifest && !isStringArray(manifest["keywords"])) {
      problems.push('plugin.json "keywords" must be an array of strings');
    }

    if ("extensions" in manifest && !isObject(manifest["extensions"])) {
      warnings.push('plugin.json "extensions" is not an object; ignored');
    }
  }

  // mcp.json: any schema error disables MCP for the whole plugin; a bad server is skipped.
  const mcpFile = resolve(root, "mcp.json");

  if (existsSync(mcpFile)) {
    const mcp = readJson(mcpFile);

    if (
      !isObject(mcp) ||
      !onlyKeys(mcp, ["$schema", "mcpServers"]) ||
      mcp["$schema"] !== MCP_SCHEMA ||
      !isObject(mcp["mcpServers"])
    ) {
      problems.push(
        `mcp.json must be exactly {"$schema": "${MCP_SCHEMA}", "mcpServers": {…}}; MCP disabled`,
      );
    } else {
      const keys = Object.keys(mcp["mcpServers"]);

      for (const key of keys) {
        const where = `mcp.json server "${key}"`;
        const server = mcp["mcpServers"][key];

        if (!SERVER_KEY.test(key)) {
          problems.push(`${where}: names may use only letters, digits, '_' and '-'`);
          continue;
        }

        const isStdio =
          isObject(server) &&
          server["type"] === "stdio" &&
          onlyKeys(server, ["type", "command", "args", "env", "cwd"]) &&
          typeof server["command"] === "string" &&
          server["command"] !== "" &&
          (server["args"] === undefined || isStringArray(server["args"])) &&
          (server["env"] === undefined || isStringMap(server["env"])) &&
          (server["cwd"] === undefined || typeof server["cwd"] === "string");

        const isRemote =
          isObject(server) &&
          (server["type"] === "streamable-http" || server["type"] === "sse") &&
          onlyKeys(server, ["type", "url", "headers"]) &&
          typeof server["url"] === "string" &&
          (server["headers"] === undefined || isStringMap(server["headers"]));

        if (!isStdio && !isRemote) {
          problems.push(
            `${where}: not a valid server (stdio allows only type, command, args, env, cwd; ` +
              "streamable-http only type, url, headers)",
          );
          continue;
        }

        const found = isStdio
          ? stdioProblems(server as unknown as StdioServer, root, data, secret)
          : remoteProblems(server, secret);

        problems.push(...found.problems.map((problem) => `${where}: ${problem}`));

        if (found.problems.length > 0) continue;

        if (found.unset !== undefined) {
          // Ziggy skips the server with a warning and loads the rest of the plugin.
          unset.push(key);
          warnings.push(`${where}: ${found.unset}; Ziggy skips this server until it is set`);
        } else if (isStdio) {
          const name = keys.length === 1 ? id : `${id}_${key}`;
          stdio.push({ key, name, server: server as unknown as StdioServer });
        }
      }
    }
  }

  // skills/<name>/SKILL.md: anything else in skills/ is ignored.
  const skills = resolve(root, "skills");

  if (existsSync(skills) && statSync(skills).isDirectory()) {
    for (const name of readdirSync(skills).toSorted()) {
      const file = resolve(skills, name, "SKILL.md");

      // Ziggy ignores entries without <name>/SKILL.md (a file such as .DS_Store included).
      if (!existsSync(file)) continue;

      if (!statSync(file).isFile()) {
        problems.push(`skills/${name}/SKILL.md: is not a regular file`);
        continue;
      }

      const text = readFileSync(file, "utf8");
      const pi = piFrontmatter(text);
      const ziggy = ziggyFrontmatter(text);
      const ziggyProblem =
        ziggy === undefined ? undefined : skillProblem(ziggy.name, ziggy.description);
      const problem =
        pi === undefined || ziggy === undefined
          ? "needs frontmatter with name and description: `---` on the first line (no BOM), " +
            "a closing line of exactly `---`"
          : "error" in pi
            ? `frontmatter is not valid YAML (quote the description): ${pi.error}`
            : (skillProblem(pi.name, pi.description) ??
              (ziggyProblem === undefined
                ? undefined
                : `as Ziggy reads it, ${ziggyProblem} (keep name and description on one line, ` +
                  "no comments)") ??
              (pi.name === name && ziggy.name === name
                ? undefined
                : `name "${pi.name}" should equal "${name}"`));

      if (problem !== undefined) problems.push(`skills/${name}/SKILL.md: ${problem}`);
    }
  }

  return { problems, warnings, unset, stdio };
};

/**
 * How Ziggy starts a stdio server that passed checkPlugin: the command, argv, env and cwd it
 * hands to Pi. Env values are literal; only PLUGIN_ROOT and PLUGIN_DATA are substituted in args.
 * Pi spawns with the session's environment plus this env, resolving a bare command from PATH.
 */
export const launch = (server: StdioServer, folder: string, dataFolder: string, secret: Secret) => {
  const root = realpathSync(folder);
  const data = realpathSync(dataFolder);

  const reserved = new Map([
    ["PLUGIN_ROOT", root],
    ["PLUGIN_DATA", data],
  ]);

  const env = server.env ?? {};
  const variables = resolveVariables(Object.values(env), secret);
  const values = new Map([...("resolved" in variables ? variables.resolved : []), ...reserved]);

  return {
    command: server.command.startsWith("./") ? resolve(root, server.command) : server.command,
    args: (server.args ?? []).map((arg) => substitute(arg, reserved)),
    env: {
      ...Object.fromEntries(
        Object.entries(env).map(([name, value]) => [name, substitute(value, values)]),
      ),
      PLUGIN_ROOT: root,
      PLUGIN_DATA: data,
    },
    cwd: workingDirectory(server.cwd, root, data) ?? root,
  };
};
