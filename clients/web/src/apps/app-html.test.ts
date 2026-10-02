import { expect, it } from "vitest";
import type { ZiggyJsonValue } from "../../../../packages/ui-sdk/src/index";
import { appHtml, appSrcdoc, cspPolicy, makeLinkGate, safeLink } from "./app-html";

const uri = "ui://fixture/view.html";

const read = (
  meta: ZiggyJsonValue,
  html = "<!doctype html><html><head></head><body>hi</body></html>",
): ZiggyJsonValue => ({
  contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: html, _meta: { ui: meta } }],
});

it("puts the CSP before any markup the view controls", () => {
  // The parser ends a comment at `<!-->` or `--!>`, so a script there would run before a meta
  // placed after the "comment".
  for (const html of [
    "<!-- c --><!DOCTYPE html><script>x()</script><head></head>",
    "<!--><script>x()</script>--><head></head>",
    "<!-- a --!><script>x()</script>--><head></head>",
  ]) {
    const view = appHtml(read({}, html), uri);
    expect(view).toBeDefined();
    const srcdoc = appSrcdoc(view!);
    expect(srcdoc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    const parsed = new DOMParser().parseFromString(srcdoc, "text/html");
    expect(parsed.querySelector("meta, script")?.tagName).toBe("META");
  }
});

it("keeps only origin sources from the view's declared CSP", () => {
  const view = appHtml(
    read({
      csp: {
        connectDomains: ["https://api.example.com", "'unsafe-eval'", "https://a.com; script-src *"],
        resourceDomains: ["https://*.cdn.example.com", "*", "data:"],
      },
    }),
    uri,
  );
  const policy = cspPolicy(view!.csp);
  expect(policy).toContain("connect-src https://api.example.com;");
  expect(policy).toContain("script-src 'unsafe-inline' https://*.cdn.example.com;");
  expect(policy).not.toContain("unsafe-eval");
  expect(policy).not.toContain(" * ");
  expect(policy).toContain("frame-src 'none'");
});

it("refuses content that is not the requested MCP Apps page", () => {
  expect(appHtml({ contents: [{ uri, mimeType: "text/html", text: "x" }] }, uri)).toBeUndefined();
  expect(appHtml(read({}), "ui://other/view.html")).toBeUndefined();
});

it("opens only http and https links", () => {
  expect(safeLink("https://example.com/a")).toBe("https://example.com/a");
  expect(safeLink("javascript:alert(1)")).toBeUndefined();
  expect(safeLink("file:///etc/passwd")).toBeUndefined();
});

it("refuses silently after a decline unless the person acts in the view", () => {
  const answers = [true, false, true];
  const asked: Array<string> = [];
  const mayOpen = makeLinkGate((url) => {
    asked.push(url);
    return answers.shift() ?? true;
  });
  expect(mayOpen("https://a.example", false)).toBe(true);
  expect(mayOpen("https://b.example", false)).toBe(false);
  expect(mayOpen("https://c.example", false)).toBe(false);
  expect(mayOpen("https://d.example", true)).toBe(true);
  expect(asked).toEqual(["https://a.example", "https://b.example"]);
});
