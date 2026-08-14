import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  PI_DOC_FILES,
  PI_DOCS_FINGERPRINT,
  PI_DOCS_PACKAGE,
  PI_DOCS_VERSION,
} from "./generated/pi-docs";
import {
  PI_DOCS_MAX_OUTPUT_BYTES,
  PI_DOCS_MAX_RESULTS,
  PI_DOCS_PATH_MAX_CODE_POINTS,
  PI_DOCS_QUERY_MAX_CODE_POINTS,
  piDocsParameters,
  createPiDocsExtension,
  createPiDocsTool,
  listPinnedPiDocs,
  loadPinnedPiDocs,
  readPinnedPiDocs,
  runPiDocsAction,
  searchPinnedPiDocs,
  type PiDocDocument,
} from "./pi-docs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryPaths: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

const resultText = async (
  params: Parameters<ReturnType<typeof createPiDocsTool>["execute"]>[1],
) => {
  const result = await createPiDocsTool().execute(
    "call-1",
    params,
    undefined,
    undefined,
    Object.create(null),
  );
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("expected a text tool result");
  }
  return content.text;
};

const fixtureDocs: ReadonlyArray<PiDocDocument> = [
  { path: "README.md", content: "alpha\nregisterTool lives here\nomega" },
  { path: "docs/sdk.md", content: "SDK embedding\nregisterTool again" },
];

describe("pinned Pi docs inventory", () => {
  test("includes README and representative docs without examples or docs.json", () => {
    const paths = [...PI_DOC_FILES.keys()];
    expect(paths[0]).toBe("README.md");
    expect(paths).toContain("docs/extensions.md");
    expect(paths).toContain("docs/sdk.md");
    expect(paths).toContain("docs/skills.md");
    expect(paths.some((path) => path.startsWith("examples/"))).toBe(false);
    expect(paths).not.toContain("docs.json");
    expect(paths.some((path) => path.endsWith(".png"))).toBe(false);

    const listed = listPinnedPiDocs(loadPinnedPiDocs());
    expect(listed).toBe(
      JSON.stringify({
        action: "list",
        package: PI_DOCS_PACKAGE,
        version: PI_DOCS_VERSION,
        paths,
      }),
    );
  });
});

describe("pinned Pi docs search and read", () => {
  test("lists, searches, and reads with stable JSON", () => {
    expect(runPiDocsAction(fixtureDocs, { action: "list" })).toBe(
      JSON.stringify({
        action: "list",
        package: PI_DOCS_PACKAGE,
        version: PI_DOCS_VERSION,
        paths: ["README.md", "docs/sdk.md"],
      }),
    );
    expect(searchPinnedPiDocs(fixtureDocs, "registertool")).toBe(
      JSON.stringify({
        action: "search",
        query: "registertool",
        truncated: false,
        matches: [
          { path: "README.md", line: 2, text: "registerTool lives here" },
          { path: "docs/sdk.md", line: 2, text: "registerTool again" },
        ],
      }),
    );
    expect(readPinnedPiDocs(fixtureDocs, "README.md", 2, 2)).toBe(
      JSON.stringify({
        action: "read",
        path: "README.md",
        startLine: 2,
        endLine: 2,
        truncated: false,
        content: "registerTool lives here",
      }),
    );
  });

  test("rejects unknown paths and bound-breaking queries", () => {
    expect(readPinnedPiDocs(fixtureDocs, "docs/missing.md", undefined, undefined)).toBe(
      JSON.stringify({ ok: false, error: "unknown_path", path: "docs/missing.md" }),
    );
    expect(readPinnedPiDocs(fixtureDocs, "examples/extensions/foo.md", undefined, undefined)).toBe(
      JSON.stringify({ ok: false, error: "unknown_path", path: "examples/extensions/foo.md" }),
    );
    expect(readPinnedPiDocs(fixtureDocs, "README.md", 2, 1)).toBe(
      JSON.stringify({ ok: false, error: "invalid_line_range" }),
    );
    expect(searchPinnedPiDocs(fixtureDocs, "a".repeat(PI_DOCS_QUERY_MAX_CODE_POINTS + 1))).toBe(
      JSON.stringify({ ok: false, error: "query_too_long", max: PI_DOCS_QUERY_MAX_CODE_POINTS }),
    );
    expect(
      readPinnedPiDocs(
        fixtureDocs,
        "x".repeat(PI_DOCS_PATH_MAX_CODE_POINTS + 1),
        undefined,
        undefined,
      ),
    ).toBe(
      JSON.stringify({ ok: false, error: "path_too_long", max: PI_DOCS_PATH_MAX_CODE_POINTS }),
    );

    const overflowLines = Array.from({ length: PI_DOCS_MAX_RESULTS + 5 }, () => "needle line");
    const overflow = searchPinnedPiDocs(
      [{ path: "README.md", content: overflowLines.join("\n") }],
      "needle",
    );
    expect(overflow).toBe(
      JSON.stringify({
        action: "search",
        query: "needle",
        truncated: true,
        matches: overflowLines.slice(0, PI_DOCS_MAX_RESULTS).map((text, index) => ({
          path: "README.md",
          line: index + 1,
          text,
        })),
      }),
    );

    const huge = "n".repeat(PI_DOCS_MAX_OUTPUT_BYTES + 64);
    const hugeRead = readPinnedPiDocs([{ path: "README.md", content: huge }], "README.md", 1, 1);
    expect(hugeRead).toContain('"truncated":true');
    expect(hugeRead).toContain('"action":"read"');
    expect(hugeRead.includes(huge)).toBe(false);
  });

  test("hidden pi_docs tool reads generated embeds and registers on a Profile runtime", async () => {
    const extension = createPiDocsExtension();
    if (!("hidden" in extension)) {
      throw new Error("expected named inline extension");
    }
    expect(extension.name).toBe("pi_docs");
    expect(extension.hidden).toBe(true);

    const listed = await resultText({ action: "list" });
    expect(listed).toContain('"README.md"');
    expect(listed).toContain('"docs/extensions.md"');

    const found = await resultText({ action: "search", query: "registerTool" });
    expect(found).toContain('"path":"docs/extensions.md"');

    const read = await resultText({
      action: "read",
      path: "docs/extensions.md",
      startLine: 3,
      endLine: 5,
    });
    expect(read).toContain("# Extensions");

    const unknown = await resultText({ action: "read", path: "docs/not-real.md" });
    expect(unknown).toBe(
      JSON.stringify({ ok: false, error: "unknown_path", path: "docs/not-real.md" }),
    );
  });
});

describe("pi docs provider schema", () => {
  test("serializes as an object-root schema for Console Go", () => {
    expect(Object.keys(piDocsParameters)).toEqual(expect.arrayContaining(["anyOf", "type"]));
    expect(JSON.stringify(piDocsParameters)).toContain('"type":"object"');
  });
});

describe("pi docs generator freshness", () => {
  test("fingerprint matches embedded files and --check is current", () => {
    const files = [...PI_DOC_FILES.entries()].map(([logical, embeddedPath]) => ({
      logical,
      content: readFileSync(embeddedPath, "utf8"),
    }));
    expect(
      createHash("sha256")
        .update(
          JSON.stringify({
            package: "@earendil-works/pi-coding-agent",
            version: "0.84.1",
            files,
          }),
        )
        .digest("hex"),
    ).toBe(PI_DOCS_FINGERPRINT);

    const check = Bun.spawnSync(["bun", "tooling/generate-pi-docs.mjs", "--check"], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(check.exitCode).toBe(0);
    expect(new TextDecoder().decode(check.stdout)).toContain(PI_DOCS_FINGERPRINT);
  });
});

describe("pi_docs Profile runtime discovery", () => {
  test("hidden factory exposes pi_docs without a checkout skill", async () => {
    const profilePath = await mkdtemp(join(tmpdir(), "ziggy-pi-docs-"));
    temporaryPaths.push(profilePath);
    await writeFile(join(profilePath, "SOUL.md"), "# Profile\n", "utf8");
    const services = await createAgentSessionServices({
      cwd: profilePath,
      agentDir: profilePath,
      resourceLoaderOptions: {
        systemPrompt: join(profilePath, "SOUL.md"),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [createPiDocsExtension()],
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions.flatMap((extension) => [...extension.tools.keys()])).toEqual([
      "pi_docs",
    ]);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(),
    });
    expect(session.getActiveToolNames()).toContain("pi_docs");
    session.dispose();
  });
});
