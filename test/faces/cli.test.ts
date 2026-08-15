/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Bun async tests own their disposable Effect execution */
import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { decodeCliCommand, isForegroundResidentArguments, renderHelp } from "ziggy/faces/cli";

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
    await expect(decode(["init", "buddy"])).resolves.toEqual({
      _tag: "Init",
      target: "buddy",
      minimal: false,
      nonInteractive: false,
    });
    await expect(decode(["run", "-c", "buddy", "hello", "there"])).resolves.toEqual({
      _tag: "Run",
      target: "buddy",
      prompt: "hello there",
      continueSession: true,
    });
    await expect(decode(["extensions", "add", "buddy", "weather"])).resolves.toEqual({
      _tag: "ExtensionsAdd",
      target: "buddy",
      id: "weather",
    });
    await expect(decode(["skills", "add", "buddy", "daily", "--force"])).rejects.toMatchObject({
      _tag: "CliInputInvalid",
      message: expect.stringContaining("skills are part of extensions"),
    });
    await expect(decode(["automations", "runs", "buddy", "morning"])).resolves.toEqual({
      _tag: "AutomationsRuns",
      target: "buddy",
      automationId: "morning",
    });
  });

  test("decodes automation definition commands", async () => {
    await expect(decode(["automations", "create", "buddy", "morning"])).resolves.toEqual({
      _tag: "AutomationsCreate",
      target: "buddy",
      automationId: "morning",
    });
    await expect(decode(["automations", "list", "buddy"])).resolves.toEqual({
      _tag: "AutomationsList",
      target: "buddy",
    });
    await expect(decode(["automations", "pause", "buddy", "morning"])).resolves.toEqual({
      _tag: "AutomationsPause",
      target: "buddy",
      automationId: "morning",
    });
    await expect(decode(["automations", "resume", "buddy", "morning"])).resolves.toEqual({
      _tag: "AutomationsResume",
      target: "buddy",
      automationId: "morning",
    });
    await expect(decode(["automations", "validate", "buddy", "morning"])).resolves.toEqual({
      _tag: "AutomationsValidate",
      target: "buddy",
      automationId: "morning",
    });
  });

  test("decodes Profile agent commands and joins direct-run prompts", async () => {
    await expect(decode(["agents", "create", "buddy", "reviewer"])).resolves.toEqual({
      _tag: "AgentsCreate",
      target: "buddy",
      agentId: "reviewer",
    });
    await expect(decode(["agents", "validate", "buddy"])).resolves.toEqual({
      _tag: "AgentsValidate",
      target: "buddy",
    });
    await expect(decode(["agents", "run", "buddy", "reviewer", "check", "this"])).resolves.toEqual({
      _tag: "AgentsRun",
      target: "buddy",
      agentId: "reviewer",
      prompt: "check this",
    });
  });

  test("decodes session commands and both resident names", async () => {
    await expect(decode(["sessions", "list", "buddy"])).resolves.toEqual({
      _tag: "SessionsList",
      target: "buddy",
    });
    await expect(decode(["sessions", "show", "buddy", "agents/child.jsonl"])).resolves.toEqual({
      _tag: "SessionsShow",
      target: "buddy",
      reference: "agents/child.jsonl",
    });
    await expect(decode(["serve", "buddy"])).resolves.toEqual({
      _tag: "Serve",
      target: "buddy",
    });
    await expect(decode(["serve", "status", "buddy"])).resolves.toEqual({
      _tag: "ServeStatus",
      target: "buddy",
    });
    await expect(decode(["serve", "install", "buddy", "--no-start", "--force"])).resolves.toEqual({
      _tag: "ServeInstall",
      target: "buddy",
      force: true,
      noStart: true,
    });
    await expect(decode(["serve", "logs", "buddy", "--follow"])).resolves.toEqual({
      _tag: "ServeLogs",
      target: "buddy",
      follow: true,
    });
    for (const [verb, tag] of [
      ["start", "ServeStart"],
      ["stop", "ServeStop"],
      ["restart", "ServeRestart"],
      ["uninstall", "ServeUninstall"],
    ] as const) {
      await expect(decode(["serve", verb, "buddy"])).resolves.toEqual({
        _tag: tag,
        target: "buddy",
      });
    }
    await expect(decode(["gateway", "buddy"])).resolves.toEqual({
      _tag: "Gateway",
      target: "buddy",
    });
  });

  test("decodes guided, minimal, and explicit non-interactive init", async () => {
    await expect(decode(["init", "buddy", "--minimal", "--non-interactive"])).resolves.toEqual({
      _tag: "Init",
      target: "buddy",
      minimal: true,
      nonInteractive: true,
    });
    await expect(
      decode([
        "init",
        "buddy",
        "--provider",
        "anthropic",
        "--model",
        "claude",
        "--thinking",
        "high",
        "--non-interactive",
      ]),
    ).resolves.toEqual({
      _tag: "Init",
      target: "buddy",
      minimal: false,
      nonInteractive: true,
      providerId: "anthropic",
      modelId: "claude",
      thinking: "high",
    });
    for (const args of [
      ["init", "buddy", "--minimal", "--model", "claude"],
      ["init", "buddy", "--provider"],
      ["init", "buddy", "--provider", "a", "--provider", "b"],
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(decodeCliCommand(args)))).toBeTrue();
    }
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
      ["agents", "run", "buddy", "reviewer"],
      ["agents", "show", "buddy"],
      ["automations", "create", "buddy"],
      ["automations", "pause", "buddy"],
      ["automations", "resume", "buddy", "daily", "extra"],
      ["automations", "validate"],
      ["sessions", "list"],
      ["sessions", "show", "buddy"],
      ["serve"],
      ["serve", "install", "buddy", "--force", "--force"],
      ["serve", "logs", "buddy", "--unknown"],
      ["serve", "start", "buddy", "extra"],
      ["--unknown"],
    ]) {
      const exit = await Effect.runPromiseExit(decodeCliCommand(args));
      expect(Exit.isFailure(exit)).toBeTrue();
    }
  });

  test("identifies only exact foreground resident commands for teardown", () => {
    expect(isForegroundResidentArguments(["serve", "buddy"])).toBeTrue();
    expect(isForegroundResidentArguments(["gateway", "buddy"])).toBeTrue();
    expect(isForegroundResidentArguments(["serve", "status", "buddy"])).toBeFalse();
    expect(isForegroundResidentArguments(["serve", "install", "buddy"])).toBeFalse();
    expect(isForegroundResidentArguments(["gateway", "buddy", "extra"])).toBeFalse();
  });

  test("renders stable general and command help", () => {
    expect(renderHelp()).toContain("ziggy tui [<name|path>]");
    expect(renderHelp()).toContain("ziggy models set");
    expect(renderHelp()).toContain("ziggy agents create|list|show|validate|run");
    expect(renderHelp()).toContain(
      "ziggy automations create|list|pause|resume|validate|status|runs",
    );
    expect(renderHelp()).toContain("ziggy sessions list|show");
    expect(renderHelp()).toContain("ziggy serve <name|path>");
    expect(renderHelp()).toContain("ziggy serve status <name|path>");
    expect(renderHelp("sessions")).toContain("sessions show");
    expect(renderHelp("serve")).toContain("ziggy serve install <name|path> [--force] [--no-start]");
    expect(renderHelp("serve")).toContain("ziggy serve logs <name|path> [--follow]");
    expect(renderHelp("models")).toBe(
      "usage:\n  ziggy models status <name|path>\n  ziggy models list <name|path> [--provider <id>]\n  ziggy models set <name|path> <provider>/<model> [--thinking <level>]",
    );
  });
});
