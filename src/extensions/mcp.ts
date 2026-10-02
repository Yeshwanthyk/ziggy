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
// Pi 0.99.1 requires this concrete class but does not export it from the package root.
import { McpOAuthCredentialStore } from "../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/oauth.js";

export interface ProfileMcpOptions {
  /** The servers this session connects; Ziggy never reads mcp.json files. */
  readonly servers?: ReadonlyArray<McpServerEntry>;
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

/** Header, env and OAuth client secret values, plus the token of a Bearer or Basic header. */
const configSecrets = (config: McpServerConfig): ReadonlyArray<string> => {
  const values =
    "url" in config
      ? [...Object.values(config.headers ?? {}), config.oauth?.clientSecret]
      : Object.values(config.env ?? {});

  return values.flatMap((raw) => {
    const value = raw === undefined ? undefined : resolvedValue(raw);

    if (value === undefined) return [];

    const token = /^(?:Bearer|Basic) (.+)$/iu.exec(value)?.[1];

    return [value, ...(token === undefined ? [] : [token])].flatMap((secret) =>
      secret.length < MIN_SECRET_LENGTH
        ? []
        : [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)],
    );
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
const redactExtension =
  (servers: ReadonlyArray<McpServerEntry>): ExtensionFactory =>
  (pi) => {
    pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
      if (!carriesMcpOutput(event.toolName)) return undefined;

      try {
        const secrets = [
          ...new Set(
            [...servers, ...pi.getMcpServers()].flatMap((server) => configSecrets(server.config)),
          ),
        ].sort((left, right) => right.length - left.length);

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

/** Pi's MCP stack for a session that may use MCP tools, with Ziggy-owned config, log and store. */
export const mcpExtensions = (
  profilePath: string,
  options: ProfileMcpOptions,
): ReadonlyArray<InlineExtension> => {
  const servers = options.servers ?? [];

  return [
    {
      name: "mcp",
      factory: createMcpExtension({
        loadConfig: () => ({ servers: [...servers], errors: [] }),
        credentials: new McpOAuthCredentialStore(refusingBackend),
        logPath: mcpLogPath(profilePath),
        startupWaitMs: 3000,
        openUrl: () => {
          throw signInDisabled();
        },
        // Caller-owned entries are session configuration, never writable mcp.json files.
        updateConfig: () => undefined,
      }),
    },
    { name: "codemode", factory: createCodemodeExtension() },
    { name: "tool-search", factory: createToolSearchExtension() },
    { name: "mcp-redact", factory: redactExtension(servers) },
  ];
};
