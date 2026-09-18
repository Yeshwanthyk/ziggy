/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor, ziggy-effect/no-json-parse, ziggy/no-unknown-parameters, ziggy/no-unknown-returns, ziggy/no-unsafe-dictionary-type, ziggy/no-runtime-typeof, ziggy/no-conditional-empty-object-spread, ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion, ziggy/require-readable-spacing -- Configuration is an untrusted filesystem boundary and failures are returned as typed Jev errors. */

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./contract.ts";

export type JevConfig = {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
};

type ConfigFile = {
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
};

const CONFIG_PATH = [".pi", "jev.json"] as const;
const CREDENTIALS_PATH = [".runtime", "jev", "credentials.json"] as const;
const MAX_CONFIG_BYTES = 32 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const boundedInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;

const readJsonFile = async (path: string): Promise<unknown | undefined> => {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not inspect Jev config at '${path}'.`);
  }
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error(`Jev config must be a private regular file: '${path}'.`);
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents) > MAX_CONFIG_BYTES)
    throw new Error(`Jev config is too large: '${path}'.`);
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Jev config is not valid JSON: '${path}'.`);
  }
};

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const readConfigFile = async (profilePath: string): Promise<ConfigFile> => {
  const value = await readJsonFile(join(profilePath, ...CONFIG_PATH));
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Jev profile config must be a JSON object.");
  if (value.model !== undefined && !boundedString(value.model, 128))
    throw new Error("Jev profile config model is invalid.");
  if (value.baseUrl !== undefined && !boundedString(value.baseUrl, 2048))
    throw new Error("Jev profile config baseUrl is invalid.");
  if (value.timeoutMs !== undefined && !boundedInteger(value.timeoutMs, 100, 120_000))
    throw new Error("Jev profile config timeoutMs must be 100-120000.");
  if (value.maxRetries !== undefined && !boundedInteger(value.maxRetries, 0, 3))
    throw new Error("Jev profile config maxRetries must be 0-3.");
  return {
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl }),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.maxRetries === undefined ? {} : { maxRetries: value.maxRetries }),
  };
};

const readCredentials = async (profilePath: string): Promise<string | undefined> => {
  const value = await readJsonFile(join(profilePath, ...CREDENTIALS_PATH));
  if (value === undefined) return undefined;
  if (!isRecord(value) || !boundedString(value.apiKey, 4096))
    throw new Error("Jev credentials file must contain a non-empty apiKey.");
  return value.apiKey;
};

const validateBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Jev baseUrl must be an absolute HTTPS URL.");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Jev baseUrl must not contain credentials, a query, or a fragment.");
  const localhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const localTestEndpoint = localhost && (url.protocol === "http:" || url.protocol === "https:");
  const productionEndpoint =
    url.protocol === "https:" &&
    url.hostname === "api.typesafe.ai" &&
    url.port === "" &&
    url.pathname === "/v1/systemone";
  if (!productionEndpoint && !localTestEndpoint)
    throw new Error(
      "Jev baseUrl must be the TypeSafe System One endpoint or an explicit localhost test endpoint.",
    );
  return url.toString().replace(/\/$/, "");
};

export const resolveJevConfig = async (
  profilePath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<JevConfig> => {
  if (!boundedString(profilePath, 4096)) throw new Error("Jev profile path is invalid.");
  const file = await readConfigFile(profilePath);
  const apiKey = environment.TYPESAFE_API_KEY?.trim() || (await readCredentials(profilePath));
  if (!apiKey)
    throw new Error(
      "Jev credentials are missing; set TYPESAFE_API_KEY or use a private .runtime/jev/credentials.json file.",
    );
  if (apiKey.length > 4096) throw new Error("Jev credentials are invalid.");
  return {
    apiKey,
    model: file.model ?? DEFAULT_MODEL,
    baseUrl: validateBaseUrl(file.baseUrl ?? DEFAULT_BASE_URL),
    timeoutMs: file.timeoutMs ?? 30_000,
    maxRetries: file.maxRetries ?? 2,
  };
};
