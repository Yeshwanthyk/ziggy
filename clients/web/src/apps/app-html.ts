import type { ZiggyJsonValue } from "../../../../packages/ui-sdk/src/index";

/** The MCP Apps view MIME type (`text/html;profile=mcp-app`). */
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export interface AppCsp {
  readonly connectDomains: ReadonlyArray<string>;
  readonly resourceDomains: ReadonlyArray<string>;
  readonly frameDomains: ReadonlyArray<string>;
}

export interface AppHtml {
  readonly html: string;
  readonly csp: AppCsp;
  readonly prefersBorder: boolean;
}

const isObject = (value: unknown): value is { readonly [key: string]: ZiggyJsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A CSP source the view may name: an http(s) or ws(s) origin, optionally with a `*.` subdomain
// wildcard. Anything else (keywords, paths, quotes, `;`) could widen or break the policy.
const CSP_SOURCE = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/iu;

const domains = (value: ZiggyJsonValue | undefined): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && CSP_SOURCE.test(entry))
    : [];

const cspOf = (meta: ZiggyJsonValue | undefined): AppCsp => {
  const csp = isObject(meta) ? meta.csp : undefined;
  const fields = isObject(csp) ? csp : {};
  return {
    connectDomains: domains(fields.connectDomains),
    resourceDomains: domains(fields.resourceDomains),
    frameDomains: domains(fields.frameDomains),
  };
};

const decodeBase64 = (value: string): string | undefined => {
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * The view's HTML and its declared CSP from a `resources/read` result: the content whose URI
 * matches and whose MIME type is the MCP Apps profile. `_meta.ui` may sit on the content or on
 * the result.
 */
export const appHtml = (result: ZiggyJsonValue, uri: string): AppHtml | undefined => {
  if (!isObject(result) || !Array.isArray(result.contents)) return undefined;
  const content = result.contents.find(
    (entry) =>
      isObject(entry) &&
      entry.uri === uri &&
      typeof entry.mimeType === "string" &&
      entry.mimeType.replaceAll(" ", "").toLowerCase() === MCP_APP_MIME_TYPE,
  );
  if (!isObject(content)) return undefined;
  const html =
    typeof content.text === "string"
      ? content.text
      : typeof content.blob === "string"
        ? decodeBase64(content.blob)
        : undefined;
  if (html === undefined) return undefined;
  const contentMeta = isObject(content._meta) ? content._meta.ui : undefined;
  const resultMeta = isObject(result._meta) ? result._meta.ui : undefined;
  const meta = contentMeta ?? resultMeta;
  return {
    html,
    csp: cspOf(meta),
    prefersBorder: isObject(meta) && meta.prefersBorder === true,
  };
};

/**
 * The policy for a view: inline script and style (a view is one HTML document), the declared
 * resource origins for scripts, styles, images, fonts and media, the declared connect origins,
 * and nothing else. Without declared origins the view cannot reach the network at all.
 */
export const cspPolicy = (csp: AppCsp): string => {
  const resources = csp.resourceDomains.join(" ");
  const withResources = (base: string) => (resources === "" ? base : `${base} ${resources}`);
  return [
    "default-src 'none'",
    `script-src ${withResources("'unsafe-inline'")}`,
    `style-src ${withResources("'unsafe-inline'")}`,
    `img-src ${withResources("data: blob:")}`,
    `font-src ${withResources("data:")}`,
    `media-src ${withResources("data: blob:")}`,
    `connect-src ${csp.connectDomains.length === 0 ? "'none'" : csp.connectDomains.join(" ")}`,
    `frame-src ${csp.frameDomains.length === 0 ? "'none'" : csp.frameDomains.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
};

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/**
 * The `srcdoc` for a view: a doctype and the CSP before any of the view's own markup. Nothing
 * from the view is allowed ahead of the policy, since the HTML parser's comment rules (`<!-->`,
 * `--!>`) would let a crafted prologue end early and run a script before the meta. A second
 * doctype in the view's HTML is a parse error the browser ignores.
 */
export const appSrcdoc = (view: AppHtml): string =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(cspPolicy(view.csp))}">${view.html}`;

/** Links a view may open: http(s) only, in a new tab without opener or referrer. */
export const safeLink = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/**
 * `ui/open-link` for one view: a gesture inside the view opens at once; otherwise the person
 * confirms. `confirm` blocks, so only one dialog is ever open; after a decline the view's later
 * requests are refused silently, so a view cannot loop dialogs.
 */
export const makeLinkGate = (confirm: (url: string) => boolean) => {
  let declined = false;
  return (url: string, gesture: boolean): boolean => {
    if (gesture) return true;
    if (declined) return false;
    declined = !confirm(url);
    return !declined;
  };
};

const APP_CONTEXT_MAX_CODE_POINTS = 4_000;

const truncate = (text: string, maximum: number): string => {
  const points = [...text];
  return points.length <= maximum ? text : `${points.slice(0, maximum - 1).join("")}…`;
};

/** The text of MCP content blocks; non-text blocks are left out. */
export const contentText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .flatMap((block: unknown) =>
          isObject(block) && block.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n\n")
    : "";

/** `ui/update-model-context` as the text Ziggy adds to the next prompt; empty clears it. */
export const modelContextText = (content: unknown, structuredContent: unknown): string => {
  const text = contentText(content);
  const structured =
    structuredContent === undefined ? "" : JSON.stringify(structuredContent, null, 1);
  return truncate(
    [text, structured].filter((part) => part.trim().length > 0).join("\n\n"),
    APP_CONTEXT_MAX_CODE_POINTS,
  );
};
