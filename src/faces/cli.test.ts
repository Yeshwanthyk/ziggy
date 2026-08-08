/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun async tests own their disposable Effect execution */
import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { decodeCliCommand, renderHelp } from "./cli";

const decode = (args: ReadonlyArray<string>) => Effect.runPromise(decodeCliCommand(args));

describe("CLI decoding", () => {
  test("decodes help and version aliases", async () => {
    await expect(decode(["help"])).resolves.toEqual({ _tag: "Help" });
    await expect(decode(["--help"])).resolves.toEqual({ _tag: "Help" });
    await expect(decode(["-h", "models"])).resolves.toEqual({
      _tag: "Help",
      topic: "models",
    });
    await expect(decode(["version"])).resolves.toEqual({ _tag: "Version" });
    await expect(decode(["--version"])).resolves.toEqual({ _tag: "Version" });
    await expect(decode(["-V"])).resolves.toEqual({ _tag: "Version" });
  });

  test("keeps bare and explicit TUI entry", async () => {
    await expect(decode([])).resolves.toEqual({ _tag: "Tui", target: "." });
    await expect(decode(["buddy"])).resolves.toEqual({ _tag: "Tui", target: "buddy" });
    await expect(decode(["tui", "help"])).resolves.toEqual({ _tag: "Tui", target: "help" });
  });

  test("preserves current command shapes", async () => {
    await expect(decode(["run", "-c", "buddy", "hello", "there"])).resolves.toEqual({
      _tag: "Run",
      target: "buddy",
      prompt: "hello there",
      continueSession: true,
    });
    await expect(decode(["skills", "add", "buddy", "daily", "--force"])).resolves.toEqual({
      _tag: "SkillsAdd",
      target: "buddy",
      source: "daily",
      force: true,
    });
    await expect(decode(["automations", "runs", "buddy", "morning"])).resolves.toEqual({
      _tag: "AutomationsRuns",
      target: "buddy",
      automationId: "morning",
    });
  });

  test("decodes model commands and model ids containing slashes", async () => {
    await expect(decode(["models", "status", "buddy"])).resolves.toEqual({
      _tag: "ModelsStatus",
      target: "buddy",
    });
    await expect(decode(["models", "list", "buddy", "--provider", "anthropic"])).resolves.toEqual({
      _tag: "ModelsList",
      target: "buddy",
      providerId: "anthropic",
    });
    await expect(
      decode([
        "models",
        "set",
        "buddy",
        "openrouter/anthropic/claude-sonnet",
        "--thinking",
        "high",
      ]),
    ).resolves.toEqual({
      _tag: "ModelsSet",
      target: "buddy",
      providerId: "openrouter",
      modelId: "anthropic/claude-sonnet",
      thinking: "high",
    });
  });

  test("rejects extra arguments and malformed reserved commands", async () => {
    for (const args of [
      ["profiles", "extra"],
      ["buddy", "extra"],
      ["tui", "buddy", "extra"],
      ["version", "extra"],
      ["models", "set", "buddy", "broken"],
      ["--unknown"],
    ]) {
      const exit = await Effect.runPromiseExit(decodeCliCommand(args));
      expect(Exit.isFailure(exit)).toBeTrue();
    }
  });

  test("renders stable general and command help", () => {
    expect(renderHelp()).toContain("ziggy tui [<name|path>]");
    expect(renderHelp()).toContain("ziggy models set");
    expect(renderHelp("models")).toBe(
      "usage:\n  ziggy models status <name|path>\n  ziggy models list <name|path> [--provider <id>]\n  ziggy models set <name|path> <provider>/<model> [--thinking <level>]",
    );
  });
});
