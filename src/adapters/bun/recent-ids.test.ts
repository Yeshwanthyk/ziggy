import { describe, expect, test } from "bun:test";
import { makeRecentIds } from "./recent-ids";

describe("recent transport IDs", () => {
  test("suppresses duplicates and evicts the oldest ID at the bound", () => {
    const ids = makeRecentIds(2);

    expect(ids.remember("a")).toBe(true);
    expect(ids.remember("a")).toBe(false);
    expect(ids.remember("b")).toBe(true);
    expect(ids.remember("c")).toBe(true);
    expect(ids.remember("a")).toBe(true);
  });
});
