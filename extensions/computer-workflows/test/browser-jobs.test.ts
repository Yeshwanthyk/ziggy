/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun tests are the package filesystem and fake-browser proof boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Fake bridge failures exercise the package boundary. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserJobFingerprint,
  buildDetailExtractionExpression,
  buildExtractionExpression,
  buildPageSignatureExpression,
  makeSavedBrowserJob,
  runSavedBrowserJob,
  validateBrowserJobDefinition,
  type BrowserJobBridge,
} from "../src/browser-jobs.ts";
import {
  listBrowserJobs,
  readBrowserJob,
  readBrowserJobBaseline,
  saveBrowserJob,
  withBrowserJobLock,
  writeBrowserJobBaseline,
  writeBrowserJobRunReport,
} from "../src/storage.ts";
import type { BrowserJobDefinition } from "../src/schema.ts";

const roots: string[] = [];

const makeProfile = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ziggy-browser-jobs-"));
  roots.push(root);

  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = (pageTwoUrl = "https://jobs.example.test/search?page=2") =>
  validateBrowserJobDefinition({
    version: 1,
    id: "saved-jobs",
    name: "Saved jobs",
    browserProfile: "jobs-monitor",
    overallTimeoutMs: 30_000,
    pages: [
      {
        id: "page-1",
        url: "https://jobs.example.test/search?page=1",
        signedInCheckpoint: { text: "Signed in" },
        readyCheckpoint: { text: "Job results page 1" },
        emptyCheckpoint: { text: "No jobs" },
        extraction: {
          itemSelector: "[data-job-id]",
          idAttribute: "data-job-id",
          titleSelector: ".title",
          linkSelector: "a.title",
          companySelector: ".company",
        },
      },
      {
        id: "page-2",
        url: pageTwoUrl,
        signedInCheckpoint: { text: "Signed in" },
        readyCheckpoint: { text: "Job results page 2" },
        emptyCheckpoint: { text: "No jobs" },
        extraction: {
          itemSelector: "[data-job-id]",
          idAttribute: "data-job-id",
          titleSelector: ".title",
          linkSelector: "a.title",
        },
      },
    ],
  });

type ExpandedDefinition = Extract<BrowserJobDefinition, { readonly version: 2 }>;

const expandedDefinition = (overrides: Partial<ExpandedDefinition> = {}) =>
  validateBrowserJobDefinition({
    version: 2,
    id: "expanded-jobs",
    name: "Expanded jobs",
    browserProfile: "jobs-monitor",
    overallTimeoutMs: 30_000,
    reportBudgetBytes: 512 * 1_024,
    pages: [
      {
        id: "search",
        url: "https://jobs.example.test/search",
        signedInCheckpoint: { text: "Signed in" },
        readyCheckpoint: { text: "Job results" },
        emptyCheckpoint: { text: "No jobs" },
        extraction: {
          itemSelector: "[data-job-id]",
          idAttribute: "data-job-id",
          titleSelector: ".title",
          linkSelector: "a.title",
          companySelector: ".company",
        },
        pagination: { nextSelector: "button.next", maxPages: 3, changeTimeoutMs: 2_000 },
      },
    ],
    detailExtraction: {
      maxItems: 10,
      allowedOrigins: ["https://jobs.example.test"],
      readyCheckpoint: { text: "Job details" },
      fields: [
        { name: "description", selector: ".description", mode: "text", required: true },
        {
          name: "requirements",
          selector: ".requirements li",
          mode: "list",
          required: false,
        },
      ],
    },
    ...overrides,
  });

type Extracted = {
  readonly id: string;
  readonly title: string;
  readonly link: string;
  readonly company?: string;
};

const fakeBridge = (
  pages: readonly (readonly Extracted[])[],
  options: { readonly failWaitAt?: number; readonly busy?: boolean } = {},
): BrowserJobBridge & { readonly calls: string[] } => {
  const calls: string[] = [];
  let page = 0;
  let waits = 0;

  return {
    calls,
    acquire: async ({ profile }) => {
      calls.push(`acquire:${profile}`);

      if (options.busy) throw new Error("browser-busy");

      return { token: "lease-1" };
    },
    navigate: async ({ url }) => {
      page += 1;
      calls.push(`navigate:${url}`);
    },
    wait: async ({ text }) => {
      waits += 1;
      calls.push(`wait:${text ?? ""}`);

      if (waits === options.failWaitAt) return { found: false, timedOut: true };

      return { found: true };
    },
    evaluate: async ({ expression }) => {
      calls.push("evaluate");
      expect(expression).toContain("document.querySelectorAll");
      expect(expression).not.toContain("jobs.example.test");

      return { value: { overflow: false, items: pages[page] ?? [] } };
    },
    click: async () => ({ status: "clicked" }),
    release: async ({ token }) => {
      calls.push(`release:${token}`);
    },
  };
};

const runStore = (profile: string) => ({
  readBaseline: async (workflowId: string) => await readBrowserJobBaseline(profile, workflowId),
  writeBaseline: async (baseline: Parameters<typeof writeBrowserJobBaseline>[1]) =>
    await writeBrowserJobBaseline(profile, baseline),
  writeReport: async (report: Parameters<typeof writeBrowserJobRunReport>[1]) =>
    await writeBrowserJobRunReport(profile, report),
});

const run = async (profile: string, workflow: BrowserJobDefinition, bridge: BrowserJobBridge) =>
  await runSavedBrowserJob({
    saved: makeSavedBrowserJob(workflow, new Date("2026-09-16T12:00:00.000Z")),
    bridge,
    store: runStore(profile),
  });

describe("saved browser jobs", () => {
  test("validates and persists a human-visible immutable recipe", async () => {
    const profile = await makeProfile();
    const workflow = definition();
    const saved = makeSavedBrowserJob(workflow, new Date("2026-09-16T10:00:00.000Z"));
    const paths = await saveBrowserJob(profile, saved);

    expect(paths.manifestPath).toBe(join(profile, "browser-workflows/saved-jobs/workflow.json"));
    expect(await readBrowserJob(profile, workflow.id)).toEqual(saved);
    expect((await listBrowserJobs(profile)).map((entry) => entry.workflow.id)).toEqual([
      "saved-jobs",
    ]);
    expect(await readFile(paths.revisionPath, "utf8")).toContain(
      '"browserProfile": "jobs-monitor"',
    );
  });

  test("rejects incomplete checkpoints, credential URLs, and arbitrary nested fields", () => {
    const valid = definition();
    expect(() =>
      validateBrowserJobDefinition({
        ...valid,
        pages: [{ ...valid.pages[0], signedInCheckpoint: {} }, valid.pages[1]],
      }),
    ).toThrow("signed-in checkpoint");
    expect(() =>
      validateBrowserJobDefinition({
        ...valid,
        pages: [
          { ...valid.pages[0], url: "https://user:secret@jobs.example.test/search" },
          valid.pages[1],
        ],
      }),
    ).toThrow("credentials");
    expect(() =>
      validateBrowserJobDefinition({
        ...valid,
        pages: [
          {
            ...valid.pages[0],
            extraction: { ...valid.pages[0].extraction, expression: "fetch('/secret')" },
          },
          valid.pages[1],
        ],
      }),
    ).toThrow();
  });

  test("builds a fixed JSON-escaped extraction expression", () => {
    const expression = buildExtractionExpression({
      itemSelector: '[data-value="${globalThis.pwned}"]',
      idAttribute: "data-id",
      titleSelector: ".title",
      linkSelector: "a",
    });

    expect(expression).toContain('"itemSelector":"[data-value=\\"${globalThis.pwned}\\"]"');
    expect(expression).not.toContain("const config = [data-value");
    expect(expression).toContain("nodes.slice(0, config.maxItems)");
  });

  test("builds service-neutral pagination clicks and detail field extraction", () => {
    const workflow = expandedDefinition();

    if (workflow.version !== 2) throw new Error("Expected v2 workflow.");
    const page = workflow.pages[0];

    if (page === undefined) throw new Error("Missing v2 page.");
    const pagination = page.pagination;
    const detail = workflow.detailExtraction;

    if (pagination === undefined || detail === undefined) throw new Error("Missing v2 config.");

    const signatureExpression = buildPageSignatureExpression(page.extraction);
    expect(signatureExpression).toContain("document.querySelectorAll");
    expect(signatureExpression).not.toContain("location.href");
    expect(signatureExpression).not.toContain("LinkedIn");

    const detailExpression = buildDetailExtractionExpression(detail);
    expect(detailExpression).toContain('"description"');
    expect(detailExpression).toContain('"requirements"');
    expect(detailExpression).toContain("value || null");
  });

  test("establishes, reloads, and advances a union baseline only after full success", async () => {
    const profile = await makeProfile();
    const workflow = definition();
    const a = { id: "a", title: "A", link: "https://jobs.example.test/a" };
    const b = { id: "b", title: "B", link: "https://jobs.example.test/b" };
    const first = await run(profile, workflow, fakeBridge([[a], [b]]));
    expect(first.report).toMatchObject({
      status: "passed",
      baselineEstablished: true,
      newItems: [],
      itemCount: 2,
    });

    const c = { id: "c", title: "C", link: "https://jobs.example.test/c" };
    const second = await run(profile, workflow, fakeBridge([[a, c], [b]]));
    expect(second.report.newItems).toEqual([{ ...c, pageId: "page-1" }]);
    expect((await readBrowserJobBaseline(profile, workflow.id))?.seenIds).toEqual(["a", "b", "c"]);

    const third = await run(profile, workflow, fakeBridge([[a, c], [b]]));
    expect(third.report.newItems).toEqual([]);
  });

  test("accepts identical page overlap but rejects conflicting stable identities", async () => {
    const profile = await makeProfile();
    const workflow = definition();
    const same = { id: "shared", title: "Shared", link: "https://jobs.example.test/shared" };
    expect((await run(profile, workflow, fakeBridge([[same], [same]]))).report).toMatchObject({
      status: "passed",
      itemCount: 1,
    });

    const conflict = { ...same, title: "Different" };
    const failed = await run(profile, workflow, fakeBridge([[same], [conflict]]));
    expect(failed.report).toMatchObject({
      status: "partial",
      failure: { code: "duplicate-id" },
      newItems: [],
    });
  });

  test("requires the explicit empty checkpoint for a zero-item page", async () => {
    const profile = await makeProfile();
    const bridge = fakeBridge([[], []], { failWaitAt: 3 });
    const completed = await run(profile, definition(), bridge);
    expect(completed.report).toMatchObject({
      status: "failed",
      pagesCompleted: [],
      failure: { code: "checkpoint-failed", pageId: "page-1" },
    });
    expect(await readBrowserJobBaseline(profile, "saved-jobs")).toBeUndefined();
    expect(bridge.calls.at(-1)).toBe("release:lease-1");
  });

  test("does not advance the baseline after second-page auth expiry", async () => {
    const profile = await makeProfile();
    const workflow = definition();
    const a = { id: "a", title: "A", link: "https://jobs.example.test/a" };
    await run(profile, workflow, fakeBridge([[a], [a]]));
    const before = await readBrowserJobBaseline(profile, workflow.id);

    const b = { id: "b", title: "B", link: "https://jobs.example.test/b" };
    const failed = await run(profile, workflow, fakeBridge([[a, b], [a]], { failWaitAt: 3 }));
    expect(failed.report).toMatchObject({ status: "partial", newItems: [] });
    expect(await readBrowserJobBaseline(profile, workflow.id)).toEqual(before);
  });

  test("resets the baseline only when source fields change", async () => {
    const profile = await makeProfile();
    const workflow = definition();
    const a = { id: "a", title: "A", link: "https://jobs.example.test/a" };
    await run(profile, workflow, fakeBridge([[a], [a]]));

    const renamed = { ...workflow, name: "Renamed", overallTimeoutMs: 45_000 };
    expect(browserJobFingerprint(renamed)).toBe(browserJobFingerprint(workflow));

    const changed = definition("https://jobs.example.test/search?page=3");
    const reset = await run(profile, changed, fakeBridge([[a], [a]]));
    expect(reset.report).toMatchObject({
      status: "passed",
      baselineReset: true,
      newItems: [],
    });
  });

  test("protects a busy browser and same-workflow concurrent run", async () => {
    const profile = await makeProfile();
    const busy = await run(profile, definition(), fakeBridge([[], []], { busy: true }));
    expect(busy.report).toMatchObject({ status: "failed", failure: { code: "browser-busy" } });

    const controller = new AbortController();
    await withBrowserJobLock(profile, "saved-jobs", controller.signal, async () => {
      await expect(
        withBrowserJobLock(profile, "saved-jobs", controller.signal, async () => undefined),
      ).rejects.toThrow("active run");
    });
  });

  test("fails an oversized final report before advancing the baseline", async () => {
    const profile = await makeProfile();
    const workflow = definition();
    const seed = { id: "seed", title: "Seed", link: "https://jobs.example.test/seed" };
    await run(profile, workflow, fakeBridge([[seed], [seed]]));
    const before = await readBrowserJobBaseline(profile, workflow.id);

    const many = Array.from({ length: 2_000 }, (_, index) => ({
      id: `job-${index}`,
      title: `Title ${index}`,
      link: `https://jobs.example.test/${index}`,
    }));

    const completed = await run(profile, workflow, fakeBridge([many, many]));

    expect(completed.report).toMatchObject({
      status: "partial",
      failure: { code: "output-cap" },
      newItems: [],
    });
    expect(await readBrowserJobBaseline(profile, workflow.id)).toEqual(before);
  });

  test("follows a bounded next control and extracts generic detail fields with provenance", async () => {
    const profile = await makeProfile();
    const workflow = expandedDefinition();
    const calls: string[] = [];

    const values: unknown[] = [
      {
        overflow: false,
        signature: '["a"]',
        nextAvailable: true,
        items: [{ id: "a", title: "A", link: "https://jobs.example.test/a" }],
      },
      { signature: '["b"]', itemCount: 1 },
      {
        overflow: false,
        signature: '["b"]',
        nextAvailable: false,
        items: [{ id: "b", title: "B", link: "https://jobs.example.test/b" }],
      },
      { description: "Build systems", requirements: ["TypeScript", "Bun"] },
      { description: "Operate systems", requirements: [] },
    ];

    const bridge: BrowserJobBridge = {
      acquire: async () => ({ token: "lease-1" }),
      navigate: async ({ url }) => {
        calls.push(`navigate:${url}`);
      },
      wait: async () => ({ found: true }),
      evaluate: async () => ({ value: values.shift() }),
      click: async () => ({ status: "clicked" }),
      release: async () => undefined,
    };

    const completed = await run(profile, workflow, bridge);
    expect(completed.report).toMatchObject({
      status: "passed",
      itemCount: 2,
      resultPagesCompleted: 2,
      detailItemsCompleted: 2,
      baselineEstablished: true,
    });
    expect(calls).toEqual([
      "navigate:https://jobs.example.test/a",
      "navigate:https://jobs.example.test/b",
    ]);
    const firstReportText = await readFile(completed.reportPath, "utf8");
    expect(firstReportText).toContain('"items": [');
    expect(firstReportText).toContain('"value": "Build systems"');
    expect(firstReportText).toContain('"selector": ".description"');

    const secondValues: unknown[] = [
      {
        overflow: false,
        signature: '["search","a"]',
        nextAvailable: false,
        items: [{ id: "a", title: "A", link: "https://jobs.example.test/a" }],
      },
      { description: "Build systems", requirements: ["TypeScript", "Bun"] },
    ];

    const secondBridge: BrowserJobBridge = {
      ...bridge,
      evaluate: async () => ({ value: secondValues.shift() }),
    };

    const second = await run(profile, workflow, secondBridge);
    expect(second.report.newItems).toEqual([]);

    const reportText = await readFile(second.reportPath, "utf8");
    expect(reportText).toContain('"detailItemsCompleted": 1');
  });

  test("reports exhausted pagination and detail budgets as partial without advancing baseline", async () => {
    const profile = await makeProfile();

    const workflow = expandedDefinition({
      detailExtraction: {
        maxItems: 1,
        allowedOrigins: ["https://jobs.example.test"],
        readyCheckpoint: { text: "Job details" },
        fields: [{ name: "description", selector: ".description", mode: "text", required: true }],
      },
      pages: [
        {
          id: "search",
          url: "https://jobs.example.test/search",
          signedInCheckpoint: { text: "Signed in" },
          readyCheckpoint: { text: "Job results" },
          emptyCheckpoint: { text: "No jobs" },
          extraction: {
            itemSelector: "[data-job-id]",
            idAttribute: "data-job-id",
            titleSelector: ".title",
            linkSelector: "a.title",
          },
          pagination: { nextSelector: "button.next", maxPages: 1 },
        },
      ],
    });

    const item = { id: "a", title: "A", link: "https://jobs.example.test/a" };

    const seedValues: unknown[] = [
      {
        overflow: false,
        signature: "one",
        nextAvailable: false,
        items: [item],
      },
      { description: "A role" },
    ];

    const seedBridge: BrowserJobBridge = {
      acquire: async () => ({ token: "lease-1" }),
      navigate: async () => undefined,
      wait: async () => ({ found: true }),
      evaluate: async () => ({ value: seedValues.shift() }),
      click: async () => ({ status: "clicked" }),
      release: async () => undefined,
    };

    const pageBudget = await run(profile, workflow, seedBridge);
    expect(pageBudget.report).toMatchObject({
      status: "passed",
      resultPagesCompleted: 1,
    });

    const before = await readBrowserJobBaseline(profile, workflow.id);

    const paginationBridge: BrowserJobBridge = {
      acquire: async () => ({ token: "lease-1" }),
      navigate: async () => undefined,
      wait: async () => ({ found: true }),
      evaluate: async () => ({
        value: { overflow: false, signature: "one", nextAvailable: true, items: [item] },
      }),
      click: async () => ({ status: "clicked" }),
      release: async () => undefined,
    };

    const partial = await run(profile, workflow, paginationBridge);
    expect(partial.report).toMatchObject({
      status: "partial",
      failure: { code: "pagination-budget" },
      newItems: [],
    });
    expect(await readBrowserJobBaseline(profile, workflow.id)).toEqual(before);

    const detailBudgetValues: unknown[] = [
      {
        overflow: false,
        signature: '["a","b"]',
        nextAvailable: false,
        items: [item, { id: "b", title: "B", link: "https://jobs.example.test/b" }],
      },
    ];

    const detailBudget = await run(profile, workflow, {
      ...seedBridge,
      evaluate: async () => ({ value: detailBudgetValues.shift() }),
    });

    expect(detailBudget.report).toMatchObject({
      status: "partial",
      failure: { code: "detail-budget" },
      newItems: [],
    });
    expect(await readBrowserJobBaseline(profile, workflow.id)).toEqual(before);
  });

  test("accepts a paginated empty page only through its checkpoint and rejects missing required details", async () => {
    const profile = await makeProfile();
    const workflow = expandedDefinition();

    const emptyPageValues: unknown[] = [
      {
        overflow: false,
        signature: '["a"]',
        nextStatus: "available",
        items: [{ id: "a", title: "A", link: "https://jobs.example.test/a" }],
      },
      { signature: "[]", itemCount: 0 },
      {
        overflow: false,
        signature: "[]",
        nextStatus: "end",
        items: [],
      },
      { description: "A role", requirements: null },
    ];

    const bridge: BrowserJobBridge = {
      acquire: async () => ({ token: "lease-1" }),
      navigate: async () => undefined,
      wait: async () => ({ found: true }),
      evaluate: async () => ({ value: emptyPageValues.shift() }),
      click: async () => ({ status: "clicked" }),
      release: async () => undefined,
    };

    const complete = await run(profile, workflow, bridge);
    expect(complete.report).toMatchObject({
      status: "passed",
      resultPagesCompleted: 2,
      detailItemsCompleted: 1,
    });

    const before = await readBrowserJobBaseline(profile, workflow.id);

    const missingValues: unknown[] = [
      {
        overflow: false,
        signature: '["a"]',
        nextStatus: "end",
        items: [{ id: "a", title: "A", link: "https://jobs.example.test/a" }],
      },
      { description: null, requirements: ["TypeScript"] },
    ];

    const missing = await run(profile, workflow, {
      ...bridge,
      evaluate: async () => ({ value: missingValues.shift() }),
    });

    expect(missing.report).toMatchObject({
      status: "partial",
      failure: { code: "missing-detail-field" },
      items: [],
      newItems: [],
    });
    expect(await readBrowserJobBaseline(profile, workflow.id)).toEqual(before);
  });
});
