import {
  hasOnlyKeys,
  isBoundedCodePointString,
  isProfileId,
  isRecord,
  isSafeInteger,
  type ZiggyProfileId,
} from "./common";

export type ZiggyMemoryPath =
  | "MEMORY.md"
  | `memory/users/${string}.md`
  | `memory/groups/${string}.md`;

export type ZiggyMemoryScope = "shared" | "person" | "group";

export interface ZiggyMemoryDocumentSummary {
  readonly path: ZiggyMemoryPath;
  readonly scope: ZiggyMemoryScope;
  readonly state: "missing" | "empty" | "present";
  readonly entryCount: number;
  readonly codePoints: number;
  readonly cap: number;
}

export interface ZiggyMemoryListResult {
  readonly profileId: ZiggyProfileId;
  readonly documents: ReadonlyArray<ZiggyMemoryDocumentSummary>;
}

export interface ZiggyMemoryShowResult {
  readonly profileId: ZiggyProfileId;
  readonly path: ZiggyMemoryPath;
  readonly scope: ZiggyMemoryScope;
  readonly state: "missing" | "empty" | "present";
  readonly content: string;
  readonly entries: ReadonlyArray<string>;
  readonly codePoints: number;
  readonly cap: number;
}

export interface ZiggyMemoryRequestMap {
  readonly "memory.list": { readonly profileId: ZiggyProfileId };
  readonly "memory.show": { readonly profileId: ZiggyProfileId; readonly path: ZiggyMemoryPath };
}

export interface ZiggyMemoryResultMap {
  readonly "memory.list": ZiggyMemoryListResult;
  readonly "memory.show": ZiggyMemoryShowResult;
}

export const memoryScopeForPath = (path: string): ZiggyMemoryScope | undefined => {
  if (path === "MEMORY.md") return "shared";
  if (/^memory\/users\/[a-z0-9._-]{1,64}\.md$/u.test(path)) return "person";
  if (/^memory\/groups\/[a-z0-9._-]{1,64}\.md$/u.test(path)) return "group";
  return undefined;
};

export const isMemoryPath = (value: unknown): value is ZiggyMemoryPath =>
  typeof value === "string" && memoryScopeForPath(value) !== undefined;

const isScope = (value: unknown): value is ZiggyMemoryScope =>
  value === "shared" || value === "person" || value === "group";

const isCount = (value: unknown): value is number => isSafeInteger(value) && value <= 1_000_000;

const isMemorySummary = (value: unknown): value is ZiggyMemoryDocumentSummary => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["path", "scope", "state", "entryCount", "codePoints", "cap"]) ||
    !isMemoryPath(value.path) ||
    !isScope(value.scope) ||
    (value.state !== "missing" && value.state !== "empty" && value.state !== "present") ||
    !isCount(value.entryCount) ||
    !isCount(value.codePoints) ||
    !isCount(value.cap)
  ) {
    return false;
  }
  const scope = memoryScopeForPath(value.path);
  const expectedCap = scope === "shared" ? 2_200 : 1_375;
  return (
    scope === value.scope &&
    value.cap === expectedCap &&
    (value.state === "empty" ? value.entryCount === 0 : value.entryCount > 0) &&
    (value.entryCount === 0 || value.codePoints > 0)
  );
};

const splitEntries = (content: string): ReadonlyArray<string> => {
  const normalized = content.trim();
  return normalized.length === 0 ? [] : normalized.split("\n§\n");
};

export const isMemoryListResult = (value: unknown): value is ZiggyMemoryListResult =>
  isRecord(value) &&
  hasOnlyKeys(value, ["profileId", "documents"]) &&
  isProfileId(value.profileId) &&
  Array.isArray(value.documents) &&
  value.documents.length <= 16 &&
  value.documents.every(isMemorySummary);

export const isMemoryShowResult = (value: unknown): value is ZiggyMemoryShowResult => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "profileId",
      "path",
      "scope",
      "state",
      "content",
      "entries",
      "codePoints",
      "cap",
    ]) ||
    !isProfileId(value.profileId) ||
    !isMemoryPath(value.path) ||
    !isScope(value.scope) ||
    (value.state !== "missing" && value.state !== "empty" && value.state !== "present") ||
    typeof value.content !== "string" ||
    !Array.isArray(value.entries) ||
    value.entries.length > 2_200 ||
    !isCount(value.codePoints) ||
    !isCount(value.cap)
  ) {
    return false;
  }
  const entriesValue = value.entries;
  if (!entriesValue.every((entry) => isBoundedCodePointString(entry, 4_096, 0))) return false;
  const scope = memoryScopeForPath(value.path);
  const expectedCap = scope === "shared" ? 2_200 : 1_375;
  const entries = splitEntries(value.content);
  return (
    scope === value.scope &&
    value.cap === expectedCap &&
    value.codePoints === [...value.content].length &&
    value.codePoints <= expectedCap &&
    entries.length === entriesValue.length &&
    entries.every((entry, index) => entry === entriesValue[index]) &&
    (value.state === "missing"
      ? value.content === "" && entriesValue.length === 0 && value.codePoints === 0
      : value.state === "empty"
        ? entriesValue.length === 0
        : entriesValue.length > 0)
  );
};
