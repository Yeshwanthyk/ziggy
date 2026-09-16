/* oxlint-disable ziggy-effect/no-native-promise-ownership -- This package is a Pi filesystem adapter boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- Boundary failures become Pi tool failures. */
/* oxlint-disable ziggy-effect/no-json-parse -- JSON is decoded immediately through the complete TypeBox schema. */
/* oxlint-disable ziggy/no-unknown-parameters -- Unknown JSON exists only at the decoder and serializer boundary. */
/* oxlint-disable ziggy/no-runtime-typeof -- Node filesystem errors require a narrow code probe at this adapter boundary. */
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Parse } from "typebox/value";
import {
  PublishApprovalSchema,
  BrowserJobBaselineSchema,
  BrowserJobRunReportSchema,
  SavedBrowserJobSchema,
  PublishedWorkflowSchema,
  RunRecordSchema,
  RunSummarySchema,
  WorkflowDraftSchema,
  type PublishApproval,
  type PublishedWorkflow,
  type RunRecord,
  type RunSummary,
  type WorkflowDraft,
  type BrowserJobBaseline,
  type BrowserJobRunReport,
  type SavedBrowserJob,
} from "./schema.ts";

const durableRoot = (profilePath: string): string => join(profilePath, "workflows");

const runtimeRoot = (profilePath: string): string =>
  join(profilePath, ".runtime", "computer-workflows");

const browserJobsRoot = (profilePath: string): string => join(profilePath, "browser-workflows");

const browserJobRuntimeRoot = (profilePath: string, workflowId: string): string =>
  join(runtimeRoot(profilePath), "jobs", workflowId);

const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;

  return typeof cause.code === "string" ? cause.code : undefined;
};

const assertDirectory = async (path: string): Promise<void> => {
  try {
    const stat = await lstat(path);

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing non-directory workflow path: ${path}`);
    }
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
    await mkdir(path, { recursive: true });
    const stat = await lstat(path);

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing non-directory workflow path: ${path}`);
    }
  }
};

const writeExclusiveJson = async (path: string, value: unknown): Promise<void> => {
  const handle = await open(path, "wx", 0o600);

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const replaceJsonAtomically = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  await writeExclusiveJson(temporary, value);
  await rename(temporary, path);
};

const readDecoded = async <const Schema extends TSchema>(
  path: string,
  schema: Schema,
): Promise<Static<Schema>> => Parse(schema, JSON.parse(await readFile(path, "utf8")));

export const writeDraft = async (profilePath: string, draft: WorkflowDraft): Promise<string> => {
  const root = join(runtimeRoot(profilePath), "drafts");
  await assertDirectory(root);
  const path = join(root, `${draft.id}.json`);
  await writeExclusiveJson(path, draft);

  return path;
};

export const readDraft = async (profilePath: string, draftId: string): Promise<WorkflowDraft> =>
  readDecoded(join(runtimeRoot(profilePath), "drafts", `${draftId}.json`), WorkflowDraftSchema);

export const publishWorkflow = async (
  profilePath: string,
  published: PublishedWorkflow,
): Promise<{ readonly manifestPath: string; readonly revisionPath: string }> => {
  const root = durableRoot(profilePath);
  await assertDirectory(root);
  const workflowRoot = join(root, published.workflow.id);
  await assertDirectory(workflowRoot);
  const revisionsRoot = join(workflowRoot, "revisions");
  await assertDirectory(revisionsRoot);
  const revisionPath = join(revisionsRoot, `${published.revision}.json`);
  await writeExclusiveJson(revisionPath, published);
  const manifestPath = join(workflowRoot, "workflow.json");
  await replaceJsonAtomically(manifestPath, published);

  return { manifestPath, revisionPath };
};

export const readWorkflow = async (
  profilePath: string,
  workflowId: string,
): Promise<PublishedWorkflow> =>
  readDecoded(join(durableRoot(profilePath), workflowId, "workflow.json"), PublishedWorkflowSchema);

export const listWorkflows = async (profilePath: string): Promise<PublishedWorkflow[]> => {
  const root = durableRoot(profilePath);
  let entries: string[];

  try {
    entries = await readdir(root);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return [];
    throw cause;
  }

  const workflows: PublishedWorkflow[] = [];

  for (const entry of entries.slice(0, 500)) {
    try {
      workflows.push(await readWorkflow(profilePath, entry));
    } catch {
      // Malformed entries are excluded from the index; workflow_show reports their exact failure.
    }
  }

  return workflows.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
};

export const writeRunRecord = async (profilePath: string, run: RunRecord): Promise<string> => {
  const root = join(runtimeRoot(profilePath), "runs");
  await assertDirectory(root);
  const path = join(root, `${run.id}.json`);
  await writeExclusiveJson(path, Parse(RunRecordSchema, run));

  return path;
};

export const writeRunSummary = async (
  profilePath: string,
  summary: RunSummary,
): Promise<string> => {
  const root = join(runtimeRoot(profilePath), "run-summaries");
  await assertDirectory(root);
  const path = join(root, `${summary.id}.json`);
  await writeExclusiveJson(path, Parse(RunSummarySchema, summary));

  return path;
};

export const writePublishApproval = async (
  profilePath: string,
  approval: PublishApproval,
): Promise<string> => {
  const root = join(runtimeRoot(profilePath), "publish-approvals");
  await assertDirectory(root);
  const path = join(root, `${approval.id}.json`);
  await writeExclusiveJson(path, approval);

  return path;
};

export const readPublishApproval = async (
  profilePath: string,
  approvalId: string,
): Promise<PublishApproval> =>
  readDecoded(
    join(runtimeRoot(profilePath), "publish-approvals", `${approvalId}.json`),
    PublishApprovalSchema,
  );

export const decodePublishedWorkflow = (value: unknown): PublishedWorkflow =>
  Parse(PublishedWorkflowSchema, value);

export const saveBrowserJob = async (
  profilePath: string,
  saved: SavedBrowserJob,
): Promise<{ readonly manifestPath: string; readonly revisionPath: string }> => {
  const root = browserJobsRoot(profilePath);
  await assertDirectory(root);
  const workflowRoot = join(root, saved.workflow.id);
  await assertDirectory(workflowRoot);
  const revisionsRoot = join(workflowRoot, "revisions");
  await assertDirectory(revisionsRoot);
  const revisionPath = join(revisionsRoot, `${saved.revision}.json`);
  await writeExclusiveJson(revisionPath, Parse(SavedBrowserJobSchema, saved));
  const manifestPath = join(workflowRoot, "workflow.json");
  await replaceJsonAtomically(manifestPath, saved);

  return { manifestPath, revisionPath };
};

export const readBrowserJob = async (
  profilePath: string,
  workflowId: string,
): Promise<SavedBrowserJob> =>
  readDecoded(
    join(browserJobsRoot(profilePath), workflowId, "workflow.json"),
    SavedBrowserJobSchema,
  );

export const listBrowserJobs = async (profilePath: string): Promise<SavedBrowserJob[]> => {
  let entries: string[];

  try {
    entries = await readdir(browserJobsRoot(profilePath));
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return [];
    throw cause;
  }

  const jobs: SavedBrowserJob[] = [];

  for (const entry of entries.slice(0, 500)) {
    try {
      jobs.push(await readBrowserJob(profilePath, entry));
    } catch {
      // Malformed entries are excluded from the index; browser_workflow_show reports the failure.
    }
  }

  return jobs.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
};

export const readBrowserJobBaseline = async (
  profilePath: string,
  workflowId: string,
): Promise<BrowserJobBaseline | undefined> => {
  try {
    return await readDecoded(
      join(browserJobRuntimeRoot(profilePath, workflowId), "baseline.json"),
      BrowserJobBaselineSchema,
    );
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
};

export const writeBrowserJobBaseline = async (
  profilePath: string,
  baseline: BrowserJobBaseline,
): Promise<void> => {
  const root = browserJobRuntimeRoot(profilePath, baseline.workflowId);
  await assertDirectory(root);
  await replaceJsonAtomically(
    join(root, "baseline.json"),
    Parse(BrowserJobBaselineSchema, baseline),
  );
};

export const writeBrowserJobRunReport = async (
  profilePath: string,
  report: BrowserJobRunReport,
): Promise<string> => {
  const root = join(browserJobRuntimeRoot(profilePath, report.workflowId), "runs");
  await assertDirectory(root);
  const path = join(root, `${report.id}.json`);
  await writeExclusiveJson(path, Parse(BrowserJobRunReportSchema, report));

  return path;
};

export const withBrowserJobLock = async <Result>(
  profilePath: string,
  workflowId: string,
  signal: AbortSignal,
  run: () => Promise<Result>,
): Promise<Result> => {
  const root = browserJobRuntimeRoot(profilePath, workflowId);
  await assertDirectory(root);
  const lockPath = join(root, "run.lock");
  signal.throwIfAborted();

  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (cause) {
    if (errorCode(cause) === "EEXIST") {
      throw new Error(`Browser workflow '${workflowId}' already has an active run.`);
    }

    throw cause;
  }

  try {
    return await run();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
};
