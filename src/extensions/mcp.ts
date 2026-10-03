import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
  type InlineExtension,
  type McpServerConfig,
  type McpServerEntry,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { Predicate, Schema } from "effect";
import { makeMcpApps, type McpApps, type McpToolApp } from "./mcp-apps";
import type { PluginMcp, PluginServer } from "./plugin";
// Pi 0.99.1 requires this concrete class but does not export it from the package root.
import { McpOAuthCredentialStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js";

export interface ProfileMcpOptions {
  /** The servers this session connects; Ziggy never reads Pi's mcp.json files. */
  readonly servers?: ReadonlyArray<McpServerEntry>;
  /** Servers from the Profile's selected Agent Plugins, already resolved by `pluginMcp`. */
  readonly plugins?: PluginMcp;
  /** The Profile runtime's MCP Apps registry; every connection goes through its transport tap. */
  readonly apps?: McpApps;
}

/** Names of tools the MCP extension creates for server tools. */
export const isMcpToolName = (name: string): boolean => name.startsWith("mcp__");

type CredentialBackend = NonNullable<ConstructorParameters<typeof McpOAuthCredentialStore>[0]>;

const signInDisabled = () =>
  new Error("MCP OAuth sign-in is disabled in Ziggy until G3; use a static Authorization header.");

/** Reads see no stored state and any write is refused, so Pi never persists OAuth state. */
const refusingBackend: CredentialBackend = {
  withLock: (fn) => {
    const { result, next } = fn(undefined);

    if (next !== undefined) throw signInDisabled();

    return result;
  },
  withLockAsync: async (fn) => {
    const { result, next } = await fn(undefined);

    if (next !== undefined) throw signInDisabled();

    return result;
  },
};

/** The per-user cache directory (`XDG_CACHE_HOME` when set); MCP logs stay outside the Profile. */
const cacheRoot = (): string => {
  const xdg = process.env["XDG_CACHE_HOME"];

  if (xdg !== undefined && xdg !== "") return xdg;

  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");

  if (process.platform === "win32")
    return process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");

  return join(homedir(), ".cache");
};

export const mcpLogPath = (profilePath: string): string =>
  join(
    cacheRoot(),
    "ziggy",
    createHash("sha256").update(profilePath).digest("hex").slice(0, 16),
    "mcp.log",
  );

// Shorter values (DEBUG=1, PORT=8080) are not secrets and would mangle unrelated output.
const MIN_SECRET_LENGTH = 8;

/**
 * A config value as Pi resolves it: `$NAME` and `${NAME}` from the environment, `$$` and `$!` as
 * literals. `!cmd` values run a command, so their output is not known here.
 */
const resolvedValue = (value: string): string | undefined =>
  value.startsWith("!")
    ? undefined
    : value.replace(
        /\$(?:([$!])|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
        (_match, literal?: string, braced?: string, bare?: string) =>
          literal ?? process.env[braced ?? bare ?? ""] ?? "",
      );

/** A secret as it may appear in output: raw, JSON-escaped and URI-encoded, plus a header's token. */
const secretForms = (value: string): ReadonlyArray<string> => {
  const token = /^(?:Bearer|Basic) (.+)$/iu.exec(value)?.[1];

  return [value, ...(token === undefined ? [] : [token])].flatMap((secret) =>
    secret.length < MIN_SECRET_LENGTH
      ? []
      : [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)],
  );
};

/** Header, env and OAuth client secret values, plus the token of a Bearer or Basic header. */
const configSecrets = (config: McpServerConfig): ReadonlyArray<string> => {
  const values =
    "url" in config
      ? [...Object.values(config.headers ?? {}), config.oauth?.clientSecret]
      : Object.values(config.env ?? {});

  return values.flatMap((raw) => {
    const value = raw === undefined ? undefined : resolvedValue(raw);

    if (value === undefined) return [];

    return secretForms(value);
  });
};

const REDACTED = "[REDACTED]";

const isJson = Schema.is(Schema.Json);

const redactText = (text: string, secrets: ReadonlyArray<string>): string =>
  secrets.reduce((current, secret) => current.replaceAll(secret, REDACTED), text);

const redactJson = (value: Schema.Json, secrets: ReadonlyArray<string>): Schema.Json => {
  if (Predicate.isString(value)) return redactText(value, secrets);

  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));

  if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactJson(item, secrets)]),
  );
};

/** Tools whose results carry MCP server output, including the codemode scripts that call them. */
const carriesMcpOutput = (name: string) =>
  isMcpToolName(name) ||
  name === "codemode" ||
  name === "read_mcp_resource" ||
  name === "list_mcp_resources" ||
  name === "list_mcp_resource_templates";

const redactResult = (
  event: ToolResultEvent,
  secrets: ReadonlyArray<string>,
): ToolResultEventResult => {
  const result: ToolResultEventResult = {
    content: event.content.map((block) =>
      block.type === "text" ? { ...block, text: redactText(block.text, secrets) } : block,
    ),
    // Details that are not JSON cannot be checked, so they are dropped.
    details: isJson(event.details) ? redactJson(event.details, secrets) : {},
  };

  // Content and structured content are replaced together; Pi drops one replaced alone.
  if (event.structuredContent !== undefined)
    result.structuredContent = redactJson(event.structuredContent, secrets);

  return result;
};

/**
 * Replace known secret values in MCP results before the model, the transcript or a codemode script
 * sees them. Nested calls from codemode emit `tool_result` too. Pi only logs a handler that throws
 * and keeps the original result, so a failure withholds the result instead.
 */
/** Every known secret form, longest first so a secret containing another is replaced whole. */
const knownSecrets = (
  servers: ReadonlyArray<Pick<McpServerEntry, "config">>,
  pluginSecrets: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  [
    ...new Set([...pluginSecrets, ...servers.flatMap((server) => configSecrets(server.config))]),
  ].sort((left, right) => right.length - left.length);

const redactExtension =
  (
    servers: ReadonlyArray<McpServerEntry>,
    known: ReadonlyArray<string>,
    apps: McpApps,
  ): ExtensionFactory =>
  (pi) => {
    const pluginSecrets = known.flatMap(secretForms);

    // App results never pass through `tool_result`; they get the same redaction here.
    apps.setRedactor((value) => {
      const secrets = knownSecrets([...servers, ...pi.getMcpServers()], pluginSecrets);

      return secrets.length === 0 ? value : redactJson(value, secrets);
    });

    pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
      if (!carriesMcpOutput(event.toolName)) return undefined;

      try {
        const secrets = knownSecrets([...servers, ...pi.getMcpServers()], pluginSecrets);

        return secrets.length === 0 ? undefined : redactResult(event, secrets);
      } catch {
        return {
          content: [{ type: "text", text: "MCP result withheld: Ziggy could not redact it." }],
          details: {},
          isError: true,
        };
      }
    });
  };

// Codemode scripts whose result has not arrived yet; one that never finishes is dropped oldest first.
const NESTED_VIEWS_MAX = 32;

/**
 * Records the view of a model-called MCP tool in `details.app`, after redaction, so live events
 * and stored history carry the same record. Content and structured content are left alone. A
 * codemode script (Pi's default exposure) carries the view of the last MCP call it made that has
 * one, since only the script's own call reaches the conversation.
 */
const appExtension =
  (apps: McpApps): ExtensionFactory =>
  (pi) => {
    const nested = new Map<string, McpToolApp>();

    pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
      if (event.toolName === "codemode") {
        const app = nested.get(event.toolCallId);
        nested.delete(event.toolCallId);

        if (app === undefined || event.isError || !isJsonRecord(event.details)) return undefined;

        return { details: { ...event.details, app } };
      }

      if (!isMcpToolName(event.toolName) || event.isError) return undefined;
      const app = apps.toolApp(event);

      if (app === undefined) return undefined;

      if (event.parentToolCallId !== undefined) {
        nested.delete(event.parentToolCallId);
        nested.set(event.parentToolCallId, app);

        for (const id of nested.keys()) {
          if (nested.size <= NESTED_VIEWS_MAX) break;
          nested.delete(id);
        }

        return undefined;
      }

      if (!isJsonRecord(event.details)) return undefined;

      return { details: { ...event.details, app } };
    });
  };

const isJsonRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

const pluginEntry = ({ name, plugin, config }: PluginServer): McpServerEntry => ({
  name,
  source: `plugin:${plugin}`,
  scope: "extension",
  config:
    "url" in config
      ? { type: "http", url: config.url, headers: { ...config.headers } }
      : {
          command: config.command,
          args: [...config.args],
          env: { ...config.env },
          cwd: config.cwd,
        },
});

// Plugin env names that carry credentials; other env values (NODE_ENV, paths) are left alone.
const SECRET_ENV_NAME = /TOKEN|KEY|SECRET|PASS|AUTH|CREDENTIAL/iu;

/**
 * What the redactor scans in a plugin server: every header value, and env values whose name
 * marks a credential, less values built from PLUGIN_ROOT or PLUGIN_DATA. Every `${NAME}` value
 * is redacted separately, whatever field it went into.
 */
const scannedPluginEntry = (server: PluginServer): McpServerEntry => {
  const entry = pluginEntry(server);

  if ("url" in entry.config) return entry;

  const { PLUGIN_ROOT: root, PLUGIN_DATA: data, ...env } = entry.config.env ?? {};

  const folders = [root, data].flatMap((folder) =>
    folder === undefined || folder === "" ? [] : [folder],
  );

  return {
    ...entry,
    config: {
      ...entry.config,
      env: Object.fromEntries(
        Object.entries(env).filter(
          ([name, value]) =>
            SECRET_ENV_NAME.test(name) && !folders.some((folder) => value.includes(folder)),
        ),
      ),
    },
  };
};

/**
 * Pi's MCP stack for a session that may use MCP tools, with Ziggy-owned config, log and store.
 * Plugin servers join only when their plugin is in `loadedPlugins` (Pi did not skip it).
 */
export const mcpExtensions = (
  profilePath: string,
  options: ProfileMcpOptions,
  loadedPlugins: ReadonlyArray<string>,
): ReadonlyArray<InlineExtension> => {
  const plugins = (options.plugins?.servers ?? []).filter((server) =>
    loadedPlugins.includes(server.plugin),
  );

  const servers = [...(options.servers ?? []), ...plugins.map(pluginEntry)];
  // Plugin configs are scanned for header values (and their Bearer/Basic tokens) and credential
  // env values; see `scannedPluginEntry`.
  // Sessions built without a runtime registry still get the tap, so app-only tools stay hidden.
  const apps = options.apps ?? makeMcpApps();
  const scanned = [...(options.servers ?? []), ...plugins.map(scannedPluginEntry)];

  return [
    {
      name: "mcp",
      factory: createMcpExtension({
        loadConfig: () => ({ servers: [...servers], errors: [...(options.plugins?.errors ?? [])] }),
        credentials: new McpOAuthCredentialStore(refusingBackend),
        logPath: mcpLogPath(profilePath),
        startupWaitMs: 3000,
        openUrl: () => {
          throw signInDisabled();
        },
        // Caller-owned entries are session configuration, never writable mcp.json files.
        updateConfig: () => undefined,
        createTransport: apps.transport,
      }),
    },
    { name: "codemode", factory: createCodemodeExtension() },
    { name: "tool-search", factory: createToolSearchExtension() },
    {
      name: "mcp-redact",
      factory: redactExtension(scanned, options.plugins?.secrets ?? [], apps),
    },
    { name: "mcp-apps", factory: appExtension(apps) },
  ];
};
