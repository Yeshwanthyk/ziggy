// Screenshot check: `bun run shots` (and the last step of `bun run check`). Renders each view in a
// stub host (shots-host.ts) with the results smoke recorded in shots/fixtures.json, plus an error
// and a loading state, in light and dark at 375 and 760 px. Fails on horizontal overflow, console
// errors and axe (WCAG A/AA) violations, which include low contrast. Screenshots go to shots/.
//
// Uses a Chrome, Chromium, Edge or Brave already on the machine, headless, with a throwaway
// profile, over the DevTools protocol: no browser download. Set CHROME_PATH to pick one. With
// --if-browser (as `check` runs it) a missing browser is a warning, not a failure.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
const OUT = join(ROOT, "shots");
const WIDTHS = [375, 760];
const THEMES = ["light", "dark"] as const;

const BROWSERS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  Bun.which("google-chrome"),
  Bun.which("chromium"),
  Bun.which("chromium-browser"),
  Bun.which("microsoft-edge"),
];
const browser = BROWSERS.find((path): path is string => Boolean(path && existsSync(path)));
if (!browser) {
  const message = "no Chrome, Chromium, Edge or Brave found (set CHROME_PATH): screenshots skipped";
  if (process.argv.includes("--if-browser")) {
    console.warn(`warning: ${message}`);
    process.exit(0);
  }
  console.error(`shots FAILED: ${message}`);
  process.exit(1);
}

const fixturesPath = join(OUT, "fixtures.json");
if (!existsSync(fixturesPath)) {
  console.error("shots FAILED: no shots/fixtures.json; run `bun run smoke` first");
  process.exit(1);
}
// The views' HTML comes from smoke's run; a build after it would be checked stale.
const distDir = join(ROOT, "dist");
const builtAfter = existsSync(distDir)
  ? readdirSync(distDir).filter(
      (file) =>
        file.endsWith(".html") &&
        statSync(join(distDir, file)).mtimeMs > statSync(fixturesPath).mtimeMs,
    )
  : [];
if (builtAfter.length > 0) {
  console.error(
    `shots FAILED: dist/${builtAfter[0]} is newer than shots/fixtures.json; run \`bun run smoke\` first`,
  );
  process.exit(1);
}
const { views, fixtures } = JSON.parse(readFileSync(fixturesPath, "utf8")) as {
  views: Record<string, string>;
  fixtures: Array<{ tool: string; uri: string; result: { structuredContent?: unknown } }>;
};

// One scenario per distinct recorded result, then an error and a loading state for each view.
interface Scenario {
  readonly name: string;
  readonly uri: string;
  readonly mode: "data" | "error" | "loading";
  readonly result?: unknown;
}
const scenarios: Scenario[] = [];
const seen = new Set<string>();
for (const { tool, uri, result } of fixtures) {
  const key = `${uri} ${JSON.stringify(result)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  scenarios.push({ name: `${tool}-${scenarios.length + 1}`, uri, mode: "data", result });
}
for (const uri of Object.keys(views)) {
  const view = uri.replace(/^ui:\/\/[^/]+\//u, "").replace(/\W+/gu, "-");
  scenarios.push({ name: `${view}-error`, uri, mode: "error" });
  scenarios.push({ name: `${view}-loading`, uri, mode: "loading" });
}

// Only this run's screenshots stay; fixtures.json is smoke's.
for (const file of readdirSync(OUT)) if (file.endsWith(".png")) rmSync(join(OUT, file));

const host = await Bun.build({ entrypoints: [join(ROOT, "shots-host.ts")], target: "browser" });
if (!host.success) throw new AggregateError(host.logs, "shots-host.ts did not build");
const hostJs = await host.outputs[0]!.text();
const axe = readFileSync(join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    const scenario = scenarios[Number(url.searchParams.get("scenario"))];
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/") {
      return html(
        '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>shots</title><script type="module" src="/host.js"></script></html>',
      );
    }
    if (url.pathname === "/host.js") {
      return new Response(hostJs, { headers: { "content-type": "text/javascript" } });
    }
    if (url.pathname === "/scenario") return Response.json(scenario);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/view.html" && scenario) return html(views[scenario.uri] ?? "");
    return new Response("not found", { status: 404 });
  },
});

// Headless browser over the DevTools protocol.
const profile = mkdtempSync(join(tmpdir(), "shots-browser-"));
const chrome = spawn(browser, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--hide-scrollbars",
  "about:blank",
]);
const endpoint = await new Promise<string>((resolve, reject) => {
  let output = "";
  chrome.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const found = /DevTools listening on (ws:\/\/\S+)/u.exec(output);
    if (found) resolve(found[1]!);
  });
  chrome.on("exit", () => reject(new Error(`browser exited:\n${output}`)));
});
const port = new URL(endpoint).port;
const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
  type: string;
  webSocketDebuggerUrl: string;
}>;
const page = targets.find((target) => target.type === "page")!;
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

let nextId = 0;
const waiting = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
let consoleErrors: string[] = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    const entry = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) entry?.reject(new Error(message.error.message));
    else entry?.resolve(message.result);
  } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(
      message.params.args.map((arg: any) => arg.value ?? arg.description).join(" "),
    );
  } else if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    consoleErrors.push(details.exception?.description ?? details.text);
  } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    consoleErrors.push(message.params.entry.text);
  }
});
const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression: string) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails)
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};

// Runs in the host page; the view's frame is same-origin here so its document is readable.
const inspect = `(async () => {
  const frame = document.querySelector("iframe");
  const doc = frame.contentDocument;
  if (!frame.contentWindow.axe) frame.contentWindow.eval(${JSON.stringify(axe)});
  const { violations, incomplete } = await frame.contentWindow.axe.run(doc, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    resultTypes: ["violations", "incomplete"],
  });
  // Contrast axe could not decide (text over an image or a gradient, overlapping boxes).
  const unsure = incomplete.filter((v) => v.id === "color-contrast");
  const box = frame.getBoundingClientRect();
  return {
    overflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
    unsure: unsure.flatMap((v) => v.nodes.map((n) => n.target.join(" "))).slice(0, 3),
    violations: violations.map((v) => \`\${v.id}: \${v.help} (\${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")})\`),
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
  };
})()`;

const problems: string[] = [];
const warnings: string[] = [];
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  for (const [index, scenario] of scenarios.entries()) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const name = `${scenario.name}-${theme}-${width}`;
        consoleErrors = [];
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 800,
          deviceScaleFactor: 2,
          mobile: width < 480,
        });
        await send("Emulation.setTouchEmulationEnabled", { enabled: width < 480 });
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        await send("Page.navigate", {
          url: `${server.url}?scenario=${index}&theme=${theme}`,
        });
        // Ready when the view says its read settled (the kit's `query` sets data-kit-state):
        // data or error, or "slow" for the loading state, whose read never answers.
        const want = scenario.mode === "loading" ? ["slow"] : ["data", "error"];
        const deadline = Date.now() + 10_000;
        let settled = false;
        while (!settled) {
          const state = await evaluate(
            `window.ready === true && (document.querySelector("iframe")?.contentDocument?.documentElement.dataset.kitState ?? "none")`,
          ).catch(() => false);
          settled = want.includes(state);
          if (!settled && Date.now() > deadline) {
            if (state === false) throw new Error(`${name}: the view did not load`);
            // A view without the kit's query gives no signal: take it as it is.
            warnings.push(`${name}: no data-kit-state from the view after 10 s`);
            break;
          }
          if (!settled) await Bun.sleep(50);
        }
        // Let the view report its height and the frame resize before the screenshot.
        await Bun.sleep(150);
        const found = (await evaluate(inspect)) as {
          overflow: number;
          unsure: string[];
          violations: string[];
          box: { x: number; y: number; width: number; height: number };
        };
        const shot = await send("Page.captureScreenshot", {
          format: "png",
          clip: { ...found.box, scale: 1 },
          captureBeyondViewport: true,
        });
        writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));

        if (found.overflow > 0) problems.push(`${name}: scrolls sideways by ${found.overflow}px`);
        for (const violation of found.violations) problems.push(`${name}: ${violation}`);
        if (found.unsure.length > 0)
          warnings.push(
            `${name}: contrast not decided by axe, look at it (${found.unsure.join(", ")})`,
          );
        for (const error of consoleErrors) problems.push(`${name}: console error: ${error}`);
        console.log(`  ${name}.png`);
      }
    }
  }
} finally {
  socket.close();
  chrome.kill();
  await server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (problems.length > 0) {
  console.error(`shots FAILED:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `shots ok: ${scenarios.length} states × light, dark × ${WIDTHS.join(", ")} px in shots/`,
);
