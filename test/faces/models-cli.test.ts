import { describe, expect, test } from "bun:test";
import { renderModelSelection, renderModels, renderModelStatus } from "ziggy/faces/models-cli";

describe("models CLI rendering", () => {
  test("renders status without exposing credentials", () => {
    expect(
      renderModelStatus({
        providerId: "anthropic",
        modelId: "claude",
        thinking: "high",
        authConfigured: true,
      }),
    ).toBe("provider\tanthropic\nmodel\tclaude\nthinking\thigh\nauth\tconfigured");
  });

  test("renders known models and empty results", () => {
    expect(
      renderModels([
        {
          providerId: "anthropic",
          modelId: "claude",
          name: "Claude",
          thinkingLevels: ["off", "high"],
        },
      ]),
    ).toBe("anthropic/claude\tClaude\tthinking: off,high");
    expect(renderModels([])).toBe("no models");
  });

  test("renders a flushed selection", () => {
    expect(
      renderModelSelection({ providerId: "anthropic", modelId: "claude", thinking: "high" }),
    ).toBe(
      "selected anthropic/claude with thinking high\nnew and resumed sessions use this selection when they open\nreopen an active TUI or run `ziggy serve restart <name|path>` for resident chats",
    );
  });
});
