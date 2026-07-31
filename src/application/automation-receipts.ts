import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import {
  AutomationRunInvalid,
  type AutomationRunReceipt,
  type AutomationRunStatus,
  parseAutomationRunReceipt,
  renderAutomationRunReceipt,
} from "../domain/automation-run";
import type { ProfileTarget } from "../domain/profile";

const RECEIPT_LIMIT = 50;

export class AutomationReceiptFileSystemError extends Schema.TaggedErrorClass<AutomationReceiptFileSystemError>()(
  "AutomationReceiptFileSystemError",
  {
    path: Schema.String,
    operation: Schema.Literals(["read", "list", "write", "remove"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class AutomationReceiptNotFound extends Schema.TaggedErrorClass<AutomationReceiptNotFound>()(
  "AutomationReceiptNotFound",
  {
    automationId: Schema.String,
    runId: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class AutomationReceiptAlreadyClaimed extends Schema.TaggedErrorClass<AutomationReceiptAlreadyClaimed>()(
  "AutomationReceiptAlreadyClaimed",
  {
    automationId: Schema.String,
    runId: Schema.String,
    path: Schema.String,
    message: Schema.String,
  },
) {}

export type AutomationReceiptError =
  | AutomationRunInvalid
  | AutomationReceiptFileSystemError
  | AutomationReceiptNotFound
  | AutomationReceiptAlreadyClaimed;

const runsDirectory = (target: ProfileTarget) =>
  join(target.path, ".runtime", "automations", "runs");
const automationDirectory = (target: ProfileTarget, automationId: string) =>
  join(runsDirectory(target), automationId);
const receiptPath = (target: ProfileTarget, automationId: string, runId: string) =>
  join(automationDirectory(target, automationId), `${runId}.md`);

const filesystemError = (
  operation: "read" | "list" | "write" | "remove",
  path: string,
  cause: unknown,
) =>
  new AutomationReceiptFileSystemError({
    path,
    operation,
    message: `could not ${operation} automation receipt at ${path}`,
    cause,
  });

export const readAutomationReceipt = (
  target: ProfileTarget,
  automationId: string,
  runId: string,
): Effect.Effect<AutomationRunReceipt, AutomationReceiptError> => {
  const path = receiptPath(target, automationId, runId);
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) =>
      fileSystemCauseDetails(cause).code === "ENOENT"
        ? new AutomationReceiptNotFound({
            automationId,
            runId,
            path,
            message: `no automation receipt ${automationId}/${runId} at ${path}`,
          })
        : filesystemError("read", path, cause),
  }).pipe(Effect.flatMap((source) => parseAutomationRunReceipt(path, source)));
};

export const listAutomationReceipts = (
  target: ProfileTarget,
  automationId: string,
): Effect.Effect<ReadonlyArray<AutomationRunReceipt>, AutomationReceiptError> => {
  const directory = automationDirectory(target, automationId);
  return Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => filesystemError("list", directory, cause),
    }).pipe(
      Effect.catchTag("AutomationReceiptFileSystemError", (failure) =>
        fileSystemCauseDetails(failure.cause).code === "ENOENT"
          ? Effect.succeed([])
          : Effect.fail(failure),
      ),
    );
    const receipts: Array<AutomationRunReceipt> = [];
    for (const entry of entries
      .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const runId = entry.name.slice(0, -3);
      receipts.push(yield* readAutomationReceipt(target, automationId, runId));
    }
    return receipts.sort(
      (left, right) =>
        Date.parse(right.claimedAt) - Date.parse(left.claimedAt) ||
        right.runId.localeCompare(left.runId),
    );
  });
};

export const latestAutomationReceipt = (
  target: ProfileTarget,
  automationId: string,
): Effect.Effect<AutomationRunReceipt | undefined, AutomationReceiptError> =>
  listAutomationReceipts(target, automationId).pipe(Effect.map((receipts) => receipts[0]));

const pruneAutomationReceipts = (
  target: ProfileTarget,
  automationId: string,
): Effect.Effect<void, AutomationReceiptError> =>
  Effect.gen(function* () {
    const receipts = yield* listAutomationReceipts(target, automationId);
    for (const receipt of receipts.slice(RECEIPT_LIMIT)) {
      const path = receiptPath(target, automationId, receipt.runId);
      yield* Effect.tryPromise({
        try: () => rm(path),
        catch: (cause) => filesystemError("remove", path, cause),
      });
    }
  });

export const writeAutomationReceipt = (
  target: ProfileTarget,
  receipt: AutomationRunReceipt,
): Effect.Effect<void, AutomationReceiptError> =>
  Effect.gen(function* () {
    const directory = automationDirectory(target, receipt.automationId);
    const path = receiptPath(target, receipt.automationId, receipt.runId);
    const temporaryPath = join(directory, `.${receipt.runId}.${crypto.randomUUID()}.tmp`);
    yield* Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true }),
      catch: (cause) => filesystemError("write", directory, cause),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(temporaryPath, renderAutomationRunReceipt(receipt), { mode: 0o600 }),
      catch: (cause) => filesystemError("write", temporaryPath, cause),
    });
    yield* Effect.tryPromise({
      try: () => rename(temporaryPath, path),
      catch: (cause) => filesystemError("write", path, cause),
    }).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () => rm(temporaryPath, { force: true }),
          catch: (cause) => filesystemError("remove", temporaryPath, cause),
        }).pipe(
          Effect.catchTag("AutomationReceiptFileSystemError", (failure) =>
            Effect.sync(() => console.error(failure.message)),
          ),
        ),
      ),
    );
    yield* pruneAutomationReceipts(target, receipt.automationId);
  });

export const claimAutomationReceipt = (
  target: ProfileTarget,
  receipt: AutomationRunReceipt,
): Effect.Effect<void, AutomationReceiptError> =>
  Effect.gen(function* () {
    const directory = automationDirectory(target, receipt.automationId);
    const path = receiptPath(target, receipt.automationId, receipt.runId);
    const temporaryPath = join(directory, `.${receipt.runId}.${crypto.randomUUID()}.tmp`);
    yield* Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true }),
      catch: (cause) => filesystemError("write", directory, cause),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(temporaryPath, renderAutomationRunReceipt(receipt), { mode: 0o600 }),
      catch: (cause) => filesystemError("write", temporaryPath, cause),
    });
    yield* Effect.tryPromise({
      try: () => link(temporaryPath, path),
      catch: (cause) =>
        fileSystemCauseDetails(cause).code === "EEXIST"
          ? new AutomationReceiptAlreadyClaimed({
              automationId: receipt.automationId,
              runId: receipt.runId,
              path,
              message: `automation receipt ${receipt.automationId}/${receipt.runId} is already claimed`,
            })
          : filesystemError("write", path, cause),
    }).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () => rm(temporaryPath, { force: true }),
          catch: (cause) => filesystemError("remove", temporaryPath, cause),
        }).pipe(
          Effect.catchTag("AutomationReceiptFileSystemError", (failure) =>
            Effect.sync(() => console.error(failure.message)),
          ),
        ),
      ),
    );
    yield* pruneAutomationReceipts(target, receipt.automationId);
  });

export const recoverRunningAutomationReceipts = (
  target: ProfileTarget,
  automationId: string,
  recoveredAt: string,
  status: Extract<AutomationRunStatus, "interrupted" | "unknown"> = "interrupted",
  claimedBefore?: string,
): Effect.Effect<ReadonlyArray<AutomationRunReceipt>, AutomationReceiptError> =>
  Effect.gen(function* () {
    const receipts = yield* listAutomationReceipts(target, automationId);
    const recovered: Array<AutomationRunReceipt> = [];
    for (const receipt of receipts) {
      if (
        receipt.status !== "running" ||
        (claimedBefore !== undefined &&
          Date.parse(receipt.claimedAt) > Date.parse(claimedBefore))
      ) {
        continue;
      }
      const terminal = {
        ...receipt,
        status,
        finishedAt: recoveredAt,
        error:
          status === "interrupted"
            ? "Run was still marked running during recovery; it will not be retried."
            : "Run outcome was unknown during recovery; it will not be retried.",
      } satisfies AutomationRunReceipt;
      yield* writeAutomationReceipt(target, terminal);
      recovered.push(terminal);
    }
    return recovered;
  });

export const recoverAllRunningAutomationReceipts = (
  target: ProfileTarget,
  recoveredAt: string,
  status: Extract<AutomationRunStatus, "interrupted" | "unknown"> = "interrupted",
  claimedBefore?: string,
): Effect.Effect<ReadonlyArray<AutomationRunReceipt>, AutomationReceiptError> =>
  Effect.gen(function* () {
    const directory = runsDirectory(target);
    const entries = yield* Effect.tryPromise({
      try: () => readdir(directory, { withFileTypes: true }),
      catch: (cause) => filesystemError("list", directory, cause),
    }).pipe(
      Effect.catchTag("AutomationReceiptFileSystemError", (failure) =>
        fileSystemCauseDetails(failure.cause).code === "ENOENT"
          ? Effect.succeed([])
          : Effect.fail(failure),
      ),
    );
    const recovered: Array<AutomationRunReceipt> = [];
    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      recovered.push(
        ...(yield* recoverRunningAutomationReceipts(
          target,
          entry.name,
          recoveredAt,
          status,
          claimedBefore,
        )),
      );
    }
    return recovered;
  });
