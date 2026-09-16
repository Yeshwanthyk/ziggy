/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tools and browser bridge callbacks are this extension's async boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Expected browser failures are converted into persisted run reports. */
/* oxlint-disable ziggy-effect/no-instanceof-error -- The Pi bridge rejects native Errors at this extension boundary. */
/* oxlint-disable ziggy/no-unknown-parameters -- Browser evaluation is decoded immediately through a complete TypeBox schema. */
/* oxlint-disable ziggy/no-conditional-empty-object-spread -- Exact optional fields are projected from schema-decoded data. */
import { createHash } from "node:crypto";
import { Parse } from "typebox/value";
import { Type, type Static } from "typebox";
import {
  BrowserJobDefinitionSchema,
  BrowserJobBaselineSchema,
  BrowserJobRunReportSchema,
  type BrowserJobBaseline,
  type BrowserJobDefinition,
  type BrowserJobRunReport,
  type ExtractedJobItem,
  type SavedBrowserJob,
} from "./schema.ts";

const MAX_EVALUATION_BYTES = 256 * 1024;

const MAX_REPORT_BYTES = 224 * 1024;

const MAX_ITEMS = 100_000;

const ExtractedValueSchema = Type.Object(
  {
    overflow: Type.Boolean(),
    items: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 1_024 }),
          title: Type.String({ minLength: 1, maxLength: 4_096 }),
          link: Type.String({ minLength: 1, maxLength: 8_192 }),
          company: Type.Optional(Type.String({ maxLength: 4_096 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: MAX_ITEMS },
    ),
  },
  { additionalProperties: false },
);

export interface BrowserJobBridge {
  readonly acquire: (
    input: { readonly url: string; readonly profile: string; readonly mode: "background" },
    signal: AbortSignal,
  ) => Promise<{ readonly token: string }>;
  readonly navigate: (
    input: { readonly url: string; readonly token: string },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly wait: (
    input: {
      readonly token: string;
      readonly text?: string;
      readonly role?: string;
      readonly until: "present";
      readonly timeoutMs?: number;
    },
    signal: AbortSignal,
  ) => Promise<{ readonly found: boolean; readonly timedOut?: boolean }>;
  readonly evaluate: (
    input: { readonly token: string; readonly expression: string },
    signal: AbortSignal,
  ) => Promise<{ readonly value: unknown }>;
  readonly release: (input: { readonly token: string }) => Promise<void>;
}

interface BrowserJobRunStore {
  readonly readBaseline: (workflowId: string) => Promise<BrowserJobBaseline | undefined>;
  readonly writeBaseline: (baseline: BrowserJobBaseline) => Promise<void>;
  readonly writeReport: (report: BrowserJobRunReport) => Promise<string>;
}

class JobFailure extends Error {
  constructor(
    readonly code: NonNullable<BrowserJobRunReport["failure"]>["code"],
    message: string,
    readonly pageId?: string,
  ) {
    super(message);
  }
}

const checkpointInput = (
  token: string,
  checkpoint: BrowserJobDefinition["pages"][number]["signedInCheckpoint"],
) => ({
  token,
  ...(checkpoint.text === undefined ? {} : { text: checkpoint.text }),
  ...(checkpoint.role === undefined ? {} : { role: checkpoint.role }),
  until: "present" as const,
  ...(checkpoint.timeoutMs === undefined ? {} : { timeoutMs: checkpoint.timeoutMs }),
});

export const validateBrowserJobDefinition = (value: unknown): BrowserJobDefinition => {
  const workflow = Parse(BrowserJobDefinitionSchema, value);

  if (workflow.pages[0].id === workflow.pages[1].id) {
    throw new Error(`Duplicate page id '${workflow.pages[0].id}'.`);
  }

  for (const page of workflow.pages) {
    const url = new URL(page.url);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Page '${page.id}' URL must use HTTP(S).`);
    }

    if (url.username !== "" || url.password !== "") {
      throw new Error(`Page '${page.id}' URL must not contain credentials.`);
    }

    for (const [label, checkpoint] of [
      ["signed-in", page.signedInCheckpoint],
      ["ready", page.readyCheckpoint],
      ["empty", page.emptyCheckpoint],
    ] as const) {
      if (checkpoint.text === undefined && checkpoint.role === undefined) {
        throw new Error(`Page '${page.id}' ${label} checkpoint must specify text or role.`);
      }
    }
  }

  return workflow;
};

export const browserJobFingerprint = (workflow: BrowserJobDefinition): string =>
  createHash("sha256")
    .update(JSON.stringify({ browserProfile: workflow.browserProfile, pages: workflow.pages }))
    .digest("hex");

export const makeSavedBrowserJob = (
  definition: BrowserJobDefinition,
  now = new Date(),
): SavedBrowserJob => ({
  format: "ziggy-saved-browser-job",
  formatVersion: 1,
  revision: crypto.randomUUID(),
  savedAt: now.toISOString(),
  sourceFingerprint: browserJobFingerprint(definition),
  workflow: definition,
});

export const buildExtractionExpression = (
  extraction: BrowserJobDefinition["pages"][number]["extraction"],
): string => {
  const config = JSON.stringify({ ...extraction, maxItems: MAX_ITEMS });

  return `(() => {
  const config = ${config};
  const text = (root, selector) => {
    const value = root.querySelector(selector)?.textContent?.trim();
    return value ? value : undefined;
  };
  const nodes = Array.from(document.querySelectorAll(config.itemSelector));
  const items = nodes.slice(0, config.maxItems).map((item) => {
    const id = item.getAttribute(config.idAttribute)?.trim();
    const linkNode = item.querySelector(config.linkSelector);
    const link = linkNode instanceof HTMLAnchorElement ? linkNode.href : linkNode?.getAttribute("href")?.trim();
    return {
      id,
      title: text(item, config.titleSelector),
      link: link || undefined,
      company: config.companySelector ? text(item, config.companySelector) : undefined,
    };
  });
  return { overflow: nodes.length > config.maxItems, items };
})()`;
};

const failureFrom = (cause: unknown, pageId?: string): JobFailure => {
  if (cause instanceof JobFailure) return cause;

  if (cause instanceof DOMException && cause.name === "AbortError") {
    return new JobFailure("cancelled", "The browser job was cancelled.", pageId);
  }

  const message = cause instanceof Error ? cause.message : "The browser operation failed.";

  if (/busy|ownership lock|already active/i.test(message)) {
    return new JobFailure("browser-busy", "The managed browser is already in use.", pageId);
  }

  return new JobFailure("browser-error", message.slice(0, 1_024), pageId);
};

const waitForCheckpoint = async (
  bridge: BrowserJobBridge,
  token: string,
  checkpoint: BrowserJobDefinition["pages"][number]["signedInCheckpoint"],
  signal: AbortSignal,
  pageId: string,
  label: string,
): Promise<void> => {
  const result = await bridge.wait(checkpointInput(token, checkpoint), signal);

  if (!result.found || result.timedOut === true) {
    throw new JobFailure(
      "checkpoint-failed",
      `Page '${pageId}' did not reach its ${label} checkpoint.`,
      pageId,
    );
  }
};

const parseItems = (value: unknown, pageId: string): ExtractedJobItem[] => {
  let encoded: string;

  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new JobFailure("invalid-extraction", "Browser extraction was not serializable.", pageId);
  }

  if (Buffer.byteLength(encoded) > MAX_EVALUATION_BYTES) {
    throw new JobFailure(
      "output-cap",
      `Page '${pageId}' extraction exceeded ${MAX_EVALUATION_BYTES} bytes.`,
      pageId,
    );
  }

  let decoded: Static<typeof ExtractedValueSchema>;

  try {
    decoded = Parse(ExtractedValueSchema, value);
  } catch {
    throw new JobFailure(
      "invalid-extraction",
      `Page '${pageId}' extraction did not match the saved job schema.`,
      pageId,
    );
  }

  if (decoded.overflow) {
    throw new JobFailure(
      "output-cap",
      `Page '${pageId}' extraction exceeded ${MAX_ITEMS} items.`,
      pageId,
    );
  }

  return decoded.items.map((item) => ({ ...item, pageId }));
};

export const runSavedBrowserJob = async (input: {
  readonly saved: SavedBrowserJob;
  readonly bridge: BrowserJobBridge;
  readonly store: BrowserJobRunStore;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}): Promise<{ readonly report: BrowserJobRunReport; readonly reportPath: string }> => {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const timeout = new AbortController();

  const timer = setTimeout(
    () => timeout.abort(new DOMException("Timed out", "TimeoutError")),
    input.saved.workflow.overallTimeoutMs,
  );

  const signal =
    input.signal === undefined ? timeout.signal : AbortSignal.any([input.signal, timeout.signal]);

  const pagesCompleted: string[] = [];
  const items: ExtractedJobItem[] = [];
  let token: string | undefined;
  let failure: JobFailure | undefined;

  try {
    signal.throwIfAborted();
    token = (
      await input.bridge.acquire(
        {
          url: input.saved.workflow.pages[0].url,
          profile: input.saved.workflow.browserProfile,
          mode: "background",
        },
        signal,
      )
    ).token;

    for (const [index, page] of input.saved.workflow.pages.entries()) {
      try {
        if (index > 0) {
          await input.bridge.navigate({ url: page.url, token }, signal);
        }

        await waitForCheckpoint(
          input.bridge,
          token,
          page.signedInCheckpoint,
          signal,
          page.id,
          "signed-in",
        );
        await waitForCheckpoint(
          input.bridge,
          token,
          page.readyCheckpoint,
          signal,
          page.id,
          "ready",
        );

        const evaluated = await input.bridge.evaluate(
          { token, expression: buildExtractionExpression(page.extraction) },
          signal,
        );

        const pageItems = parseItems(evaluated.value, page.id);

        if (pageItems.length === 0) {
          await waitForCheckpoint(
            input.bridge,
            token,
            page.emptyCheckpoint,
            signal,
            page.id,
            "empty",
          );
        }

        items.push(...pageItems);
        pagesCompleted.push(page.id);
      } catch (cause) {
        throw failureFrom(cause, page.id);
      }
    }

    const byId = new Map<string, ExtractedJobItem>();

    for (const item of items) {
      const prior = byId.get(item.id);

      if (prior !== undefined) {
        if (
          prior.title !== item.title ||
          prior.link !== item.link ||
          prior.company !== item.company
        ) {
          throw new JobFailure(
            "duplicate-id",
            `Stable job id '${item.id}' had conflicting extracted identity.`,
          );
        }

        continue;
      }

      byId.set(item.id, item);
    }

    items.splice(0, items.length, ...byId.values());

    if (Buffer.byteLength(JSON.stringify(items)) > MAX_EVALUATION_BYTES) {
      throw new JobFailure(
        "output-cap",
        `Combined extraction exceeded ${MAX_EVALUATION_BYTES} bytes.`,
      );
    }
  } catch (cause) {
    if (signal.aborted) {
      failure = new JobFailure(
        timeout.signal.aborted ? "timeout" : "cancelled",
        timeout.signal.aborted
          ? "The browser job exceeded its overall timeout."
          : "The browser job was cancelled.",
      );
    } else {
      failure = failureFrom(cause);
    }
  } finally {
    if (token !== undefined) {
      try {
        await input.bridge.release({ token });
      } catch (cause) {
        failure ??= failureFrom(cause);
      }
    }

    if (signal.aborted) {
      failure = new JobFailure(
        timeout.signal.aborted ? "timeout" : "cancelled",
        timeout.signal.aborted
          ? "The browser job exceeded its overall timeout."
          : "The browser job was cancelled.",
      );
    }
  }

  return await (async () => {
    const prior = await input.store.readBaseline(input.saved.workflow.id);

    if (signal.aborted) {
      failure = new JobFailure(
        timeout.signal.aborted ? "timeout" : "cancelled",
        timeout.signal.aborted
          ? "The browser job exceeded its overall timeout."
          : "The browser job was cancelled.",
      );
    }

    const baselineReset =
      prior !== undefined && prior.sourceFingerprint !== input.saved.sourceFingerprint;

    const priorIds =
      prior === undefined || baselineReset ? new Set<string>() : new Set<string>(prior.seenIds);

    const newItems =
      prior === undefined || baselineReset ? [] : items.filter((item) => !priorIds.has(item.id));

    const makeReport = (currentFailure: JobFailure | undefined): BrowserJobRunReport => {
      const successful = currentFailure === undefined;

      return Parse(BrowserJobRunReportSchema, {
        format: "ziggy-browser-job-run-report",
        formatVersion: 1,
        id: crypto.randomUUID(),
        workflowId: input.saved.workflow.id,
        revision: input.saved.revision,
        sourceFingerprint: input.saved.sourceFingerprint,
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
        status: successful
          ? "passed"
          : currentFailure?.code === "cancelled"
            ? "cancelled"
            : "failed",
        baselineEstablished: successful && prior === undefined,
        baselineReset: successful && baselineReset,
        itemCount: items.length,
        newItems: successful ? newItems : [],
        pagesCompleted,
        ...(currentFailure === undefined
          ? {}
          : {
              failure: {
                code: currentFailure.code,
                ...(currentFailure.pageId === undefined ? {} : { pageId: currentFailure.pageId }),
                message: currentFailure.message,
              },
            }),
      });
    };

    let report = makeReport(failure);

    if (Buffer.byteLength(JSON.stringify(report, null, 2)) > MAX_REPORT_BYTES) {
      failure = new JobFailure(
        "output-cap",
        `Browser workflow report exceeded ${MAX_REPORT_BYTES} bytes.`,
      );
      report = makeReport(failure);
    }

    const nextBaseline =
      failure === undefined
        ? Parse(BrowserJobBaselineSchema, {
            format: "ziggy-browser-job-baseline",
            formatVersion: 1,
            workflowId: input.saved.workflow.id,
            sourceFingerprint: input.saved.sourceFingerprint,
            updatedAt: now().toISOString(),
            seenIds: [...new Set([...priorIds, ...items.map((item) => item.id)])].sort(),
          })
        : undefined;

    // This is the commit linearization point. Abort and timeout are observed before the durable
    // report; once it is written, the matching baseline update must complete as one logical commit.
    if (signal.aborted) {
      failure = new JobFailure(
        timeout.signal.aborted ? "timeout" : "cancelled",
        timeout.signal.aborted
          ? "The browser job exceeded its overall timeout."
          : "The browser job was cancelled.",
      );
      report = makeReport(failure);
    }

    clearTimeout(timer);
    const reportPath = await input.store.writeReport(report);

    if (failure === undefined && nextBaseline !== undefined) {
      await input.store.writeBaseline(nextBaseline);
    }

    return { report, reportPath };
  })().finally(() => clearTimeout(timer));
};
