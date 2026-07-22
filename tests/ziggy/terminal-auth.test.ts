import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { readTerminalSecret, type SecretTerminal } from "../../packages/ziggy/src/terminal-auth.ts";
import { runEffect } from "../testkit/effect.ts";

class FakeTerminal implements SecretTerminal {
  readonly isTTY = true;
  isRaw = true;
  readableEncoding: BufferEncoding | null = "utf16le";
  readableFlowing: boolean | null = false;
  readonly calls: string[] = [];
  readonly listeners = new Set<(chunk: string | Buffer) => void>();
  failAt: string | undefined;

  setEncoding(encoding: BufferEncoding | null): void {
    this.calls.push(`encoding:${encoding ?? "none"}`);
    this.readableEncoding = encoding;
    this.fail("encoding");
  }
  resume(): void {
    this.calls.push("resume");
    this.readableFlowing = true;
    this.fail("resume");
  }
  pause(): void {
    this.calls.push("pause");
    this.readableFlowing = false;
    this.fail("pause");
  }
  setRawMode(enabled: boolean): void {
    this.calls.push(`raw:${enabled}`);
    this.isRaw = enabled;
    this.fail("raw");
  }
  onData(listener: (chunk: string | Buffer) => void): void {
    this.calls.push("onData");
    this.listeners.add(listener);
    this.fail("onData");
  }
  offData(listener: (chunk: string | Buffer) => void): void {
    this.calls.push("offData");
    this.listeners.delete(listener);
  }
  write(_value: string): void {
    this.calls.push("write");
    this.fail("write");
  }
  private fail(operation: string): void {
    if (this.failAt === operation) {
      this.failAt = undefined;
      throw new Error(`fixture ${operation} failure`);
    }
  }
}

for (const operation of ["encoding", "resume", "raw", "write", "onData"]) {
  test(`secret terminal rolls back prior state when ${operation} setup fails`, async () => {
    const terminal = new FakeTerminal();
    terminal.failAt = operation;
    await expect(
      runEffect(readTerminalSecret("Key", new AbortController().signal, terminal)),
    ).rejects.toThrow(
      operation === "onData"
        ? "Failed to install authentication terminal listeners"
        : "Failed to prepare authentication terminal",
    );
    expect(terminal.isRaw).toBe(true);
    expect(terminal.readableEncoding).toBe("utf16le");
    expect(terminal.readableFlowing).toBe(false);
    expect(terminal.listeners.size).toBe(0);
  });
}

test("secret terminal does not mutate on pre-abort", async () => {
  const terminal = new FakeTerminal();
  const abort = new AbortController();
  abort.abort();
  await expect(runEffect(readTerminalSecret("Key", abort.signal, terminal))).rejects.toThrow(
    "cancelled",
  );
  expect(terminal.calls).toEqual([]);
});

test("secret terminal restores OS-significant state and safely pauses an initially null stream", async () => {
  const terminal = new FakeTerminal();
  terminal.isRaw = false;
  terminal.readableFlowing = null;
  const prompt = runEffect(readTerminalSecret("Key", new AbortController().signal, terminal));
  emit(terminal, "value\n");
  await expect(prompt).resolves.toBe("value");
  expectRestoredAndPaused(terminal, false);
});

test("secret terminal safely pauses an initially null stream after cancellation", async () => {
  const terminal = new FakeTerminal();
  terminal.isRaw = false;
  terminal.readableFlowing = null;
  const abort = new AbortController();
  const prompt = runEffect(readTerminalSecret("Key", abort.signal, terminal));
  abort.abort();
  await expect(prompt).rejects.toThrow("cancelled");
  expectRestoredAndPaused(terminal, false);
});

test("secret terminal safely pauses an initially null stream after setup failure", async () => {
  const terminal = new FakeTerminal();
  terminal.isRaw = false;
  terminal.readableFlowing = null;
  terminal.failAt = "onData";
  await expect(
    runEffect(readTerminalSecret("Key", new AbortController().signal, terminal)),
  ).rejects.toThrow("Failed to install authentication terminal listeners");
  expectRestoredAndPaused(terminal, false);
});

test("secret terminal leaves an initially flowing stream safely paused", async () => {
  const terminal = new FakeTerminal();
  terminal.isRaw = false;
  terminal.readableFlowing = true;
  const prompt = runEffect(readTerminalSecret("Key", new AbortController().signal, terminal));
  emit(terminal, "value\n");
  await expect(prompt).resolves.toBe("value");
  expectRestoredAndPaused(terminal, false);
});

test("secret terminal restores state when its Effect fiber is interrupted", async () => {
  const terminal = new FakeTerminal();
  terminal.isRaw = false;
  await runEffect(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        readTerminalSecret("Key", new AbortController().signal, terminal),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
    }),
  );
  expectRestoredAndPaused(terminal, false);
});

function emit(terminal: FakeTerminal, value: string): void {
  const listener = [...terminal.listeners][0];
  if (listener === undefined) throw new Error("missing terminal listener");
  listener(value);
}

function expectRestoredAndPaused(terminal: FakeTerminal, raw: boolean): void {
  expect(terminal.isRaw).toBe(raw);
  expect(terminal.readableEncoding).toBe("utf16le");
  expect(readFlowing(terminal)).toBe(false);
  expect(terminal.listeners.size).toBe(0);
}

function readFlowing(terminal: SecretTerminal): boolean | null {
  return terminal.readableFlowing;
}
