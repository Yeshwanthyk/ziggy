import { describe, expect, test } from "bun:test";
import { MEMORY_ENTRY_DELIMITER, applyMemoryOperations, memoryEntries } from "./memory";

describe("applyMemoryOperations", () => {
  test("add is idempotent for an exact duplicate", () => {
    const initial = "already known\n";
    expect(
      applyMemoryOperations(initial, [{ action: "add", content: " already known " }], 100),
    ).toEqual({
      ok: true,
      content: initial,
      changed: false,
    });
  });

  test("replace rejects zero matches", () => {
    const result = applyMemoryOperations(
      "one\n",
      [{ action: "replace", oldText: "missing", content: "replacement" }],
      100,
    );
    expect(result).toEqual({
      ok: false,
      message:
        "operation 1 (replace) matched 0 entries for oldText; use text that identifies exactly one entry",
    });
  });

  test("replace rejects matches in two entries", () => {
    const result = applyMemoryOperations(
      `shared detail one${MEMORY_ENTRY_DELIMITER}shared detail two\n`,
      [{ action: "replace", oldText: "shared detail", content: "replacement" }],
      100,
    );
    expect(result).toEqual({
      ok: false,
      message:
        "operation 1 (replace) matched 2 entries for oldText; use text that identifies exactly one entry",
    });
  });

  test("remove deletes the single matching entry", () => {
    const result = applyMemoryOperations(
      `keep${MEMORY_ENTRY_DELIMITER}remove this${MEMORY_ENTRY_DELIMITER}also keep\n`,
      [{ action: "remove", oldText: "remove" }],
      100,
    );
    expect(result).toEqual({
      ok: true,
      content: `keep${MEMORY_ENTRY_DELIMITER}also keep\n`,
      changed: true,
    });
  });

  test("rejects the entry delimiter inside content", () => {
    const result = applyMemoryOperations(
      "",
      [{ action: "add", content: `one${MEMORY_ENTRY_DELIMITER}two` }],
      100,
    );
    expect(result).toEqual({
      ok: false,
      message: "operation 1 (add) rejected: content must not contain the memory entry delimiter",
    });
  });

  test("overflow rejects the whole batch and reports code-point counts", () => {
    expect(
      applyMemoryOperations(
        "kept\n",
        [
          { action: "add", content: "first" },
          { action: "add", content: "second" },
        ],
        10,
      ),
    ).toEqual({
      ok: false,
      message: "memory full: 22/10 code points — consolidate or remove entries first",
    });
  });

  test("replace works for a legacy document without a delimiter", () => {
    const result = applyMemoryOperations(
      "legacy fact",
      [{ action: "replace", oldText: "legacy", content: "current fact" }],
      100,
    );
    expect(result).toEqual({
      ok: true,
      content: "current fact\n",
      changed: true,
    });
    expect(memoryEntries("current fact\n")).toEqual(["current fact"]);
  });
});
