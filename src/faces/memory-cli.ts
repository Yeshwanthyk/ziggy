import { Schema } from "effect";
import type { MemoryDocumentView } from "../application/memory";

const MemoryListItemJson = Schema.Struct({
  scope: Schema.Literals(["shared", "person", "group"]),
  path: Schema.String,
  state: Schema.Literals(["empty", "present", "missing"]),
  entries: Schema.Finite,
  codePoints: Schema.Finite,
  cap: Schema.Finite,
});
export const MemoryListJson = Schema.Array(MemoryListItemJson);
export type MemoryListJson = typeof MemoryListJson.Type;

const MemoryShowJson = Schema.Struct({
  scope: Schema.Literals(["shared", "person", "group"]),
  path: Schema.String,
  state: Schema.Literals(["empty", "present", "missing"]),
  entries: Schema.Array(Schema.String),
  codePoints: Schema.Finite,
  cap: Schema.Finite,
});
export type MemoryShowJson = typeof MemoryShowJson.Type;

const encodeList = Schema.encodeSync(MemoryListJson);
const encodeShow = Schema.encodeSync(MemoryShowJson);

const jsonItem = (item: MemoryDocumentView): MemoryListJson[number] => ({
  scope: item.document.scope,
  path: item.document.relativePath,
  state: item.state,
  entries: item.entries.length,
  codePoints: item.codePoints,
  cap: item.cap,
});

const jsonShow = (item: MemoryDocumentView): MemoryShowJson => ({
  scope: item.document.scope,
  path: item.document.relativePath,
  state: item.state,
  entries: [...item.entries],
  codePoints: item.codePoints,
  cap: item.cap,
});

export const renderMemoryList = (items: ReadonlyArray<MemoryDocumentView>): string =>
  items.length === 0
    ? "no memory documents"
    : items
        .map(
          (item) =>
            `${item.document.relativePath}\t${item.state}\t${item.entries.length} entries\t${item.codePoints}/${item.cap} code points`,
        )
        .join("\n");

export const renderMemoryListJson = (items: ReadonlyArray<MemoryDocumentView>): string =>
  JSON.stringify(encodeList(items.map(jsonItem)));

export const renderMemoryShow = (item: MemoryDocumentView): string => {
  const lines = [
    `path\t${item.document.relativePath}`,
    `scope\t${item.document.scope}`,
    `state\t${item.state}`,
    `entries\t${item.entries.length}`,
    `code points\t${item.codePoints}/${item.cap}`,
  ];
  for (const [index, entry] of item.entries.entries()) lines.push(`${index + 1}\t${entry}`);
  return lines.join("\n");
};

export const renderMemoryShowJson = (item: MemoryDocumentView): string =>
  JSON.stringify(encodeShow(jsonShow(item)));
