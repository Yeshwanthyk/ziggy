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

const V1_MAX_REPORT_BYTES = 224 * 1024;

const MAX_ITEMS = 100_000;

const ExtractedValueSchema = Type.Object(
  {
    overflow: Type.Boolean(),
    signature: Type.Optional(Type.String({ maxLength: 16_384 })),
    nextAvailable: Type.Optional(Type.Boolean()),
    nextStatus: Type.Optional(
      Type.Union([Type.Literal("available"), Type.Literal("end"), Type.Literal("ambiguous")]),
    ),
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

const ClickValueSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("clicked"), Type.Literal("end"), Type.Literal("ambiguous")]),
  },
  { additionalProperties: false },
);

const PageSignatureSchema = Type.Object(
  {
    signature: Type.String({ maxLength: 16_384 }),
    itemCount: Type.Integer({ minimum: 0, maximum: MAX_ITEMS }),
  },
  { additionalProperties: false },
);

const DetailValueSchema = Type.Record(
  Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", minLength: 1, maxLength: 80 }),
  Type.Union([
    Type.String({ maxLength: 64 * 1_024 }),
    Type.Array(Type.String({ maxLength: 16 * 1_024 }), { maxItems: 1_000 }),
    Type.Null(),
  ]),
);

type JobPage = BrowserJobDefinition["pages"][number];

type V2BrowserJob = Extract<BrowserJobDefinition, { readonly version: 2 }>;

type Pagination = NonNullable<V2BrowserJob["pages"][number]["pagination"]>;

type DetailExtraction = NonNullable<V2BrowserJob["detailExtraction"]>;

const isV2Page = (page: JobPage): page is V2BrowserJob["pages"][number] => "pagination" in page;

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
  readonly click: (
    input: { readonly token: string; readonly selector: string },
    signal: AbortSignal,
  ) => Promise<{ readonly status: "clicked" | "end" | "ambiguous" }>;
  readonly release: (input: { readonly token: string }) => Promise<void>;
}

interface BrowserJobRunStore {
  readonly readBaseline: (workflowId: string) => Promise<BrowserJobBaseline | undefined>;
  readonly writeBaseline: (baseline: BrowserJobBaseline) => Promise<void>;
  readonly writeReport: (report: BrowserJobRunReport) => Promise<string>;
}

interface ParsedItems {
  readonly items: ExtractedJobItem[];
  readonly signature: string;
  readonly nextStatus: "available" | "end" | "ambiguous";
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

const checkpointInput = (token: string, checkpoint: JobPage["signedInCheckpoint"]) => ({
  token,
  ...(checkpoint.text === undefined ? {} : { text: checkpoint.text }),
  ...(checkpoint.role === undefined ? {} : { role: checkpoint.role }),
  until: "present" as const,
  ...(checkpoint.timeoutMs === undefined ? {} : { timeoutMs: checkpoint.timeoutMs }),
});

export const validateBrowserJobDefinition = (value: unknown): BrowserJobDefinition => {
  const workflow = Parse(BrowserJobDefinitionSchema, value);

  const pageIds = new Set<string>();

  for (const page of workflow.pages) {
    if (pageIds.has(page.id)) throw new Error(`Duplicate page id '${page.id}'.`);
    pageIds.add(page.id);
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

  if (workflow.version === 2 && workflow.detailExtraction !== undefined) {
    const fieldNames = new Set<string>();

    for (const field of workflow.detailExtraction.fields) {
      if (fieldNames.has(field.name)) throw new Error(`Duplicate detail field '${field.name}'.`);
      fieldNames.add(field.name);
    }

    for (const originValue of workflow.detailExtraction.allowedOrigins) {
      const origin = new URL(originValue);

      if (
        (origin.protocol !== "http:" && origin.protocol !== "https:") ||
        origin.origin !== originValue
      ) {
        throw new Error(`Detail allowed origin '${originValue}' must be an exact HTTP(S) origin.`);
      }
    }

    const checkpoint = workflow.detailExtraction.readyCheckpoint;

    if (checkpoint.text === undefined && checkpoint.role === undefined) {
      throw new Error("Detail ready checkpoint must specify text or role.");
    }
  }

  return workflow;
};

export const browserJobFingerprint = (workflow: BrowserJobDefinition): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        browserProfile: workflow.browserProfile,
        pages: workflow.pages,
        ...(workflow.version === 2 ? { detailExtraction: workflow.detailExtraction } : {}),
      }),
    )
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
  extraction: JobPage["extraction"],
  pagination?: Pagination,
): string => {
  const config = JSON.stringify({ ...extraction, maxItems: MAX_ITEMS, pagination });

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
  const nextNodes = config.pagination
    ? Array.from(document.querySelectorAll(config.pagination.nextSelector))
    : [];
  const next = nextNodes.length === 1 ? nextNodes[0] : undefined;
  const disabled =
    (next instanceof HTMLButtonElement && next.disabled) ||
    next?.getAttribute("aria-disabled") === "true" ||
    next?.hasAttribute("disabled") === true;
  return {
    overflow: nodes.length > config.maxItems,
    items,
    signature: JSON.stringify(items.map((item) => item.id)),
    nextAvailable: nextNodes.length === 1 && !disabled,
    nextStatus: nextNodes.length > 1 ? "ambiguous" : nextNodes.length === 1 && !disabled ? "available" : "end",
  };
})()`;
};

export const buildPageSignatureExpression = (extraction: JobPage["extraction"]): string => {
  const config = JSON.stringify({
    itemSelector: extraction.itemSelector,
    idAttribute: extraction.idAttribute,
  });

  return `(() => {
  const config = ${config};
  const ids = Array.from(document.querySelectorAll(config.itemSelector))
    .map((item) => item.getAttribute(config.idAttribute)?.trim())
    .filter(Boolean);
  return { signature: JSON.stringify(ids), itemCount: ids.length };
})()`;
};

export const buildDetailExtractionExpression = (detail: DetailExtraction): string => {
  const fields = JSON.stringify(detail.fields);

  return `(() => {
  const fields = ${fields};
  return Object.fromEntries(fields.map((field) => {
    const nodes = Array.from(document.querySelectorAll(field.selector));
    if (field.mode === "list") {
      const values = nodes.map((node) => node.textContent?.trim()).filter(Boolean);
      return [field.name, values.length > 0 ? values : null];
    }
    const value = nodes[0]?.textContent?.trim();
    return [field.name, value || null];
  }));
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
  checkpoint: JobPage["signedInCheckpoint"],
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

const parseItems = (value: unknown, pageId: string): ParsedItems => {
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

  return {
    items: decoded.items.map((item) => ({ ...item, pageId })),
    signature: decoded.signature ?? JSON.stringify(decoded.items.map((item) => item.id)),
    nextStatus: decoded.nextStatus ?? (decoded.nextAvailable === true ? "available" : "end"),
  };
};

const delay = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
};

const waitForChangedResultPage = async (input: {
  readonly bridge: BrowserJobBridge;
  readonly token: string;
  readonly extraction: JobPage["extraction"];
  readonly priorSignature: string;
  readonly timeoutMs: number;
  readonly emptyCheckpoint: JobPage["emptyCheckpoint"];
  readonly signal: AbortSignal;
  readonly pageId: string;
}): Promise<void> => {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    input.signal.throwIfAborted();

    try {
      const evaluated = await input.bridge.evaluate(
        {
          token: input.token,
          expression: buildPageSignatureExpression(input.extraction),
        },
        input.signal,
      );

      const current = Parse(PageSignatureSchema, evaluated.value);

      if (current.itemCount > 0 && current.signature !== input.priorSignature) return;

      if (current.itemCount === 0) {
        const remaining = deadline - Date.now();

        const empty = await input.bridge.wait(
          checkpointInput(input.token, {
            ...input.emptyCheckpoint,
            timeoutMs: Math.max(100, Math.min(500, remaining)),
          }),
          input.signal,
        );

        if (empty.found && empty.timedOut !== true) return;
      }
    } catch (cause) {
      if (input.signal.aborted) throw cause;
      // A full-page navigation can briefly replace the CDP execution context. Retry against the
      // lease's fresh browser state until the bounded change deadline.
    }

    await delay(100, input.signal);
  }

  throw new JobFailure(
    "pagination-stalled",
    `Page '${input.pageId}' did not expose changed stable IDs or its explicit empty checkpoint after next.`,
    input.pageId,
  );
};

const validateDetailUrl = (value: string, detail: DetailExtraction, pageId: string): URL => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new JobFailure("detail-url", `Item detail URL '${value}' is not absolute.`, pageId);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    !detail.allowedOrigins.includes(url.origin)
  ) {
    throw new JobFailure(
      "detail-url",
      `Item detail URL '${value}' is outside the saved allowed origins.`,
      pageId,
    );
  }

  return url;
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
  let resultPagesCompleted = 0;
  let detailItemsCompleted = 0;
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

        const pagination = isV2Page(page) ? page.pagination : undefined;
        const maxPages = pagination?.maxPages ?? 1;

        for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
          const evaluated = await input.bridge.evaluate(
            { token, expression: buildExtractionExpression(page.extraction, pagination) },
            signal,
          );

          const extracted = parseItems(evaluated.value, page.id);

          if (extracted.items.length === 0) {
            await waitForCheckpoint(
              input.bridge,
              token,
              page.emptyCheckpoint,
              signal,
              page.id,
              "empty",
            );
          }

          items.push(...extracted.items);
          resultPagesCompleted += 1;

          if (pagination === undefined || extracted.nextStatus === "end") break;

          if (extracted.nextStatus === "ambiguous") {
            throw new JobFailure(
              "pagination-stalled",
              `Page '${page.id}' matched more than one next control.`,
              page.id,
            );
          }

          if (pageNumber === maxPages) {
            throw new JobFailure(
              "pagination-budget",
              `Page '${page.id}' still had another result page after its ${maxPages}-page budget.`,
              page.id,
            );
          }

          const advanced = Parse(
            ClickValueSchema,
            await input.bridge.click({ token, selector: pagination.nextSelector }, signal),
          );

          if (advanced.status === "end") break;

          if (advanced.status !== "clicked") {
            throw new JobFailure(
              "pagination-stalled",
              `Page '${page.id}' next control was ${advanced.status}.`,
              page.id,
            );
          }

          await waitForChangedResultPage({
            bridge: input.bridge,
            token,
            extraction: page.extraction,
            priorSignature: extracted.signature,
            timeoutMs: pagination.changeTimeoutMs ?? 10_000,
            emptyCheckpoint: page.emptyCheckpoint,
            signal,
            pageId: page.id,
          });

          await waitForCheckpoint(
            input.bridge,
            token,
            page.readyCheckpoint,
            signal,
            page.id,
            "ready",
          );
        }

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

    const detail =
      input.saved.workflow.version === 2 ? input.saved.workflow.detailExtraction : undefined;

    if (detail !== undefined) {
      if (items.length > detail.maxItems) {
        throw new JobFailure(
          "detail-budget",
          `The run found ${items.length} items but the detail budget is ${detail.maxItems}.`,
        );
      }

      for (const [index, item] of items.entries()) {
        const url = validateDetailUrl(item.link, detail, item.pageId);
        await input.bridge.navigate({ token, url: url.href }, signal);
        await waitForCheckpoint(
          input.bridge,
          token,
          detail.readyCheckpoint,
          signal,
          item.pageId,
          `detail ready for item '${item.id}'`,
        );

        const evaluated = await input.bridge.evaluate(
          { token, expression: buildDetailExtractionExpression(detail) },
          signal,
        );

        const values = Parse(DetailValueSchema, evaluated.value);

        for (const field of detail.fields) {
          const value = values[field.name];

          if (
            field.required &&
            (value === undefined || value === null || (Array.isArray(value) && value.length === 0))
          ) {
            throw new JobFailure(
              "missing-detail-field",
              `Item '${item.id}' did not contain required detail field '${field.name}'.`,
              item.pageId,
            );
          }
        }

        items[index] = {
          ...item,
          details: Object.fromEntries(
            detail.fields.map((field) => [
              field.name,
              {
                value: values[field.name] ?? null,
                source: { url: url.href, selector: field.selector, mode: field.mode },
              },
            ]),
          ),
        };
        detailItemsCompleted += 1;
      }
    }

    const reportBudgetBytes =
      input.saved.workflow.version === 2
        ? input.saved.workflow.reportBudgetBytes
        : V1_MAX_REPORT_BYTES;

    if (Buffer.byteLength(JSON.stringify(items)) > reportBudgetBytes) {
      throw new JobFailure(
        "output-cap",
        `Combined extraction exceeded the saved ${reportBudgetBytes}-byte report budget.`,
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
      const hasProgress = resultPagesCompleted > 0 || detailItemsCompleted > 0;

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
            : hasProgress
              ? "partial"
              : "failed",
        baselineEstablished: successful && prior === undefined,
        baselineReset: successful && baselineReset,
        itemCount: items.length,
        items: successful ? items : [],
        newItems: successful ? newItems : [],
        pagesCompleted,
        resultPagesCompleted,
        detailItemsCompleted,
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

    const reportBudgetBytes =
      input.saved.workflow.version === 2
        ? input.saved.workflow.reportBudgetBytes
        : V1_MAX_REPORT_BYTES;

    if (Buffer.byteLength(JSON.stringify(report, null, 2)) > reportBudgetBytes) {
      failure = new JobFailure(
        "output-cap",
        `Browser workflow report exceeded the saved ${reportBudgetBytes}-byte budget.`,
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
