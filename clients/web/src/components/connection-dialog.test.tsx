import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./connection-dialog";
import type { ModelSettingsState } from "@/gateway";

const modelSettings: ModelSettingsState = {
  availableModels: [
    {
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      thinkingLevels: ["low", "medium", "high"],
    },
    {
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      thinkingLevels: ["low", "high"],
    },
  ],
  loading: false,
  models: [],
  providers: [],
  saving: false,
  status: {
    authConfigured: true,
    modelId: "gpt-5.6-sol",
    profileId: "prf_squarey",
    providerId: "openai-codex",
    thinking: "medium",
  },
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

describe("SettingsDialog", () => {
  it("keeps model edits local until Save model is pressed", async () => {
    const onSaveModel = vi.fn(async () => undefined);
    render(
      <SettingsDialog
        connected
        connectionPending={false}
        modelSettings={modelSettings}
        onConnect={vi.fn(async () => undefined)}
        onOpenChange={vi.fn()}
        onSaveModel={onSaveModel}
        open
        profileName="Squarey"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /GPT-5.6 Sol/u }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet 4/u }));

    expect(onSaveModel).not.toHaveBeenCalled();
    expect((screen.getByRole("radio", { name: "low" }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    await waitFor(() =>
      expect(onSaveModel).toHaveBeenCalledExactlyOnceWith("anthropic", "claude-sonnet-4", "high"),
    );
  });
});
