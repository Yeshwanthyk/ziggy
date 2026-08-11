/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests execute application Effects */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun test callbacks are the Promise boundary */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { ZiggyReleaseClientShape } from "../adapters/github/self-update";
import { makeSelfUpdate } from "./self-update";

const releaseClient = (onDownload: () => void): ZiggyReleaseClientShape => ({
  downloadLatest: () =>
    Effect.sync(() => {
      onDownload();
      return {
        version: "1.2.3",
        executable: new TextEncoder().encode("ziggy"),
        sha256: "0".repeat(64),
      };
    }),
});

describe("self update orchestration", () => {
  test("source mode fails before downloading or touching Bun", async () => {
    let downloads = 0;
    const service = makeSelfUpdate(
      releaseClient(() => downloads++),
      {
        standalone: false,
        executablePath: "/opt/homebrew/bin/bun",
      },
    );

    const failure = await Effect.runPromise(Effect.flip(service.update()));

    expect(failure._tag).toBe("ZiggyUpdateUnavailable");
    expect(failure.message).toContain("standalone Ziggy executable");
    expect(downloads).toBe(0);
  });

  test("standalone mode delegates one checksum-pinned atomic install", async () => {
    let downloads = 0;
    let installed: ReadonlyArray<unknown> = [];
    const service = makeSelfUpdate(
      releaseClient(() => downloads++),
      { standalone: true, executablePath: "/tmp/ziggy" },
      (targetPath, executable, sha256) =>
        Effect.sync(() => {
          installed = [targetPath, new TextDecoder().decode(executable), sha256];
        }),
    );

    const result = await Effect.runPromise(service.update());

    expect(result).toEqual({ path: "/tmp/ziggy", version: "1.2.3" });
    expect(downloads).toBe(1);
    expect(installed).toEqual(["/tmp/ziggy", "ziggy", "0".repeat(64)]);
  });
});
