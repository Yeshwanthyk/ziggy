/* eslint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is a Promise adapter boundary. */
/* eslint-disable ziggy-effect/no-try-catch-or-throw -- Throwing from a Pi tool marks the tool result as failed. */
/* eslint-disable ziggy-effect/no-error-constructor -- Pi tool failures cross this boundary as rejected Error values. */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const JINA_READER_URL = "https://r.jina.ai/";

const TIMEOUT_MS = 30_000;

const MAX_REDIRECTS = 5;

const USER_AGENT = "ziggy-web-search/0.1";

const MAX_BYTES = 5 * 1024 * 1024;

export const MAX_OUTPUT_CHARS = 24 * 1024;

interface FetchDetails {
  source: "direct" | "jina";
  status: number;
  url: string;
  jinaFallbackError?: string;
}

export interface FetchResult {
  readonly text: string;
  readonly details: FetchDetails;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const clip = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}\n[output truncated]`;

const isPrivateIpv4 = (ip: string): boolean => {
  const [a = 0, b = 0] = ip.split(".").map(Number);

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && b >= 18 && b <= 19) ||
    a >= 224
  );
};

/** Unknown address shapes count as private so the guard fails closed. */
export const isPrivateIp = (value: string): boolean => {
  const ip = value.toLowerCase().replace(/^\[|\]$/g, "");

  if (isIP(ip) === 4) return isPrivateIpv4(ip);

  if (isIP(ip) !== 6) return true;

  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];

  if (mapped !== undefined) return isPrivateIpv4(mapped);

  return (
    ip === "::" ||
    ip === "::1" ||
    ip.startsWith("::ffff:") ||
    /^fe[89ab]/.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  );
};

/** Rejects non-HTTP(S) URLs and any host that names or resolves to a private address. */
export const assertPublicUrl = async (raw: string): Promise<URL> => {
  const url = URL.parse(raw) ?? fail("URL must be a valid absolute HTTP(S) URL.");

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("Only HTTP(S) URLs are supported.");
  }

  const hostname = url.hostname.toLowerCase();
  const literal = hostname.replace(/^\[|\]$/g, "");

  if (
    !hostname ||
    hostname === "localhost" ||
    [".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => hostname.endsWith(suffix))
  ) {
    fail("Private and local hostnames are not allowed.");
  }

  if (isIP(literal) !== 0) {
    if (isPrivateIp(literal)) fail("Private and local IP addresses are not allowed.");

    return url;
  }

  let addresses: ReadonlyArray<{ readonly address: string }> = [];

  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    fail(`Could not resolve hostname: ${hostname}`);
  }

  if (addresses.length === 0 || addresses.some((address) => isPrivateIp(address.address))) {
    fail("URL resolves to a private or local network address.");
  }

  return url;
};

const requestSignal = (signal: AbortSignal | undefined): AbortSignal =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

const fetchPublic = async (
  raw: string,
  signal: AbortSignal | undefined,
): Promise<{ response: Response; url: URL }> => {
  let current = await assertPublicUrl(raw);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      headers: {
        accept: "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1",
        "user-agent": USER_AGENT,
      },
      redirect: "manual",
      signal: requestSignal(signal),
    });

    const location = response.headers.get("location");

    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      return { response, url: current };
    }

    await response.body?.cancel();
    current = await assertPublicUrl(new URL(location, current).toString());
  }

  return fail("Too many redirects.");
};

/** Reads a response body, failing once it exceeds `maxBytes`. */
export const readBounded = async (response: Response, maxBytes = MAX_BYTES): Promise<string> => {
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
    fail(`Response exceeds the ${maxBytes} byte limit.`);
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      total += next.value.byteLength;

      if (total > maxBytes) fail(`Response exceeds the ${maxBytes} byte limit.`);
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The body is already complete or failed; cancelling only releases the stream.
    }
  }

  return text + decoder.decode();
};

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

const decodeEntities = (value: string): string =>
  value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const code = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : entity.startsWith("#")
        ? Number.parseInt(entity.slice(1), 10)
        : undefined;

    if (code === undefined) return NAMED_ENTITIES.get(entity.toLowerCase()) ?? whole;

    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const htmlToText = (html: string) => {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";

  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(
      /<\/(article|aside|blockquote|br|div|h[1-6]|li|main|p|pre|section|table|tr|ul)>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    title: decodeEntities(rawTitle.replace(/<[^>]+>/g, " ")).trim(),
    text: decodeEntities(text),
  };
};

const needsJina = (text: string, contentType: string, status: number): boolean =>
  status >= 400 ||
  (contentType.includes("html") &&
    (text.length < 240 ||
      /enable javascript|checking your browser|captcha|cookie consent/i.test(text)));

/** Fetches a public URL as readable text, falling back to Jina Reader for blocked or script-only pages. */
export const fetchUrl = async (
  raw: string,
  options: {
    readonly jinaFallback: boolean;
    readonly maxChars: number;
    readonly signal: AbortSignal | undefined;
  },
): Promise<FetchResult> => {
  const direct = await fetchPublic(raw, options.signal);
  const contentType = direct.response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await readBounded(direct.response);
  const parsed = contentType.includes("html") ? htmlToText(body) : { title: "", text: body.trim() };

  const directText = clip(
    parsed.title ? `# ${parsed.title}\n\n${parsed.text}` : parsed.text,
    options.maxChars,
  );

  const directResult = (jinaFallbackError?: string): FetchResult => {
    const details: FetchDetails = {
      source: "direct",
      status: direct.response.status,
      url: direct.url.toString(),
    };

    if (jinaFallbackError !== undefined) details.jinaFallbackError = jinaFallbackError;

    return { text: directText, details };
  };

  if (!options.jinaFallback || !needsJina(parsed.text, contentType, direct.response.status)) {
    return directResult();
  }

  try {
    const jina = await fetch(`${JINA_READER_URL}${direct.url.toString()}`, {
      headers: { accept: "text/markdown, text/plain;q=0.9", "user-agent": USER_AGENT },
      signal: requestSignal(options.signal),
    });

    const jinaBody = await readBounded(jina);

    if (!jina.ok) fail(`Jina returned HTTP ${jina.status}.`);

    return {
      text: clip(jinaBody.trim(), options.maxChars),
      details: { source: "jina", status: jina.status, url: direct.url.toString() },
    };
  } catch (error) {
    if (options.signal?.aborted || !direct.response.ok || parsed.text.length === 0) throw error;

    return directResult(String(error));
  }
};
