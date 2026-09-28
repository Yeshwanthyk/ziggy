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
        onRetrySettings={vi.fn(async () => undefined)}
        onToggleExtension={vi.fn(async () => undefined)}
        sessionModel={{ pending: false }}
        sessionBusy={false}
        onLoadSessionModel={vi.fn(async () => undefined)}
        onChangeSessionModel={vi.fn(async () => undefined)}
        onChangeSessionThinking={vi.fn(async () => undefined)}
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

    const modelTrigger = screen.getByRole("combobox", { name: "Model" });
    expect(modelTrigger.textContent).toContain("GPT-5.6 Sol");
    fireEvent.click(modelTrigger);
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet 4/u }));

    expect(onSaveModel).not.toHaveBeenCalled();
    expect((screen.getByRole("radio", { name: "low" }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "high" }));
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    await waitFor(() =>
      expect(onSaveModel).toHaveBeenCalledExactlyOnceWith("anthropic", "claude-sonnet-4", "high"),
    );
  });
});

it("offers retry instead of an empty model form when settings are unavailable", () => {
  const retry = vi.fn(async () => undefined);
  render(
    <SettingsDialog
      connected
      connectionPending={false}
      open
      profileName="Squarey"
      onConnect={vi.fn(async () => undefined)}
      onOpenChange={vi.fn()}
      onSaveModel={vi.fn(async () => undefined)}
      onRetrySettings={retry}
      onToggleExtension={vi.fn(async () => undefined)}
      sessionModel={{ pending: false }}
      sessionBusy={false}
      onLoadSessionModel={vi.fn(async () => undefined)}
      onChangeSessionModel={vi.fn(async () => undefined)}
      onChangeSessionThinking={vi.fn(async () => undefined)}
    />,
  );
  expect(screen.getByText("Model settings could not be loaded.")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Save model" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry loading settings" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

it("offers both selected and unselected extensions without optimistic selection", () => {
  const toggle = vi.fn(async () => undefined);
  render(
    <SettingsDialog
      connected
      connectionPending={false}
      open
      profileName="Squarey"
      modelSettings={{
        ...modelSettings,
        extensions: {
          profileId: "prf_squarey",
          available: [
            { id: "bundled-one", kind: "code", source: "bundled", description: "Bundled" },
            { id: "installed-one", kind: "skill", source: "profile", description: "Installed" },
          ],
          selected: ["bundled-one"],
          skipped: [],
          truncated: false,
        },
      }}
      onConnect={vi.fn(async () => undefined)}
      onOpenChange={vi.fn()}
      onSaveModel={vi.fn(async () => undefined)}
      onRetrySettings={vi.fn(async () => undefined)}
      onToggleExtension={toggle}
      sessionModel={{ pending: false }}
      sessionBusy={false}
      onLoadSessionModel={vi.fn(async () => undefined)}
      onChangeSessionModel={vi.fn(async () => undefined)}
      onChangeSessionThinking={vi.fn(async () => undefined)}
    />,
  );
  const selected = screen.getByRole("switch", { name: "bundled-one" }) as HTMLInputElement;
  const unselected = screen.getByRole("switch", { name: "installed-one" }) as HTMLInputElement;
  expect(selected.checked).toBe(true);
  expect(unselected.checked).toBe(false);
  fireEvent.click(unselected);
  expect(toggle).toHaveBeenCalledExactlyOnceWith("installed-one", false);
  expect(unselected.checked).toBe(false);
});

it("renders a selected id absent from the catalog so it can be disabled", () => {
  const toggle = vi.fn(async () => undefined);
  render(
    <SettingsDialog
      connected
      connectionPending={false}
      open
      profileName="Squarey"
      modelSettings={{
        ...modelSettings,
        extensions: {
          profileId: "prf_squarey",
          available: [],
          selected: ["missing-one"],
          skipped: [],
          truncated: true,
        },
        restartRequired: true,
      }}
      onConnect={vi.fn(async () => undefined)}
      onOpenChange={vi.fn()}
      onSaveModel={vi.fn(async () => undefined)}
      onRetrySettings={vi.fn(async () => undefined)}
      onToggleExtension={toggle}
      sessionModel={{ pending: false }}
      sessionBusy={false}
      onLoadSessionModel={vi.fn(async () => undefined)}
      onChangeSessionModel={vi.fn(async () => undefined)}
      onChangeSessionThinking={vi.fn(async () => undefined)}
    />,
  );
  expect((screen.getByRole("switch", { name: "missing-one" }) as HTMLInputElement).checked).toBe(
    true,
  );
  expect(screen.getByText(/Extension list truncated/u)).not.toBeNull();
  expect(screen.getByText(/Restart the resident to apply extension changes/u)).not.toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "missing-one" }));
  expect(toggle).toHaveBeenCalledExactlyOnceWith("missing-one", true);
});

it("keeps live session switches disabled while streaming, without changing Profile defaults", () => {
  const switchModel = vi.fn(async () => undefined);
  render(
    <SettingsDialog
      connected
      connectionPending={false}
      open
      profileName="Squarey"
      selectedRef={{ profileId: "prf_squarey", kind: "live", key: "local/main" }}
      sessionBusy
      sessionModel={{
        pending: false,
        value: {
          profileId: "prf_squarey",
          ref: { profileId: "prf_squarey", kind: "live", key: "local/main" },
          providerId: "openai-codex",
          modelId: "gpt-5.6-sol",
          thinking: "medium",
        },
      }}
      modelSettings={modelSettings}
      onConnect={vi.fn(async () => undefined)}
      onOpenChange={vi.fn()}
      onSaveModel={vi.fn(async () => undefined)}
      onRetrySettings={vi.fn(async () => undefined)}
      onToggleExtension={vi.fn(async () => undefined)}
      onLoadSessionModel={vi.fn(async () => undefined)}
      onChangeSessionModel={switchModel}
      onChangeSessionThinking={vi.fn(async () => undefined)}
    />,
  );
  expect(
    (screen.getByRole("combobox", { name: "Session model" }) as HTMLSelectElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("combobox", { name: "Session thinking" }) as HTMLSelectElement).disabled,
  ).toBe(true);
  expect(screen.getByRole("button", { name: "Save model" })).not.toBeNull();
  expect(switchModel).not.toHaveBeenCalled();
});

it("marks held transcripts and does not offer them for resume", () => {
  const resume = vi.fn(async () => undefined);
  render(
    <SettingsDialog
      connected
      connectionPending={false}
      open
      profileName="Squarey"
      selectedRef={{ profileId: "prf_squarey", kind: "live", key: "local/main" }}
      sessionBusy={false}
      sessionModel={{ pending: false }}
      sessionSummaries={{
        pending: false,
        value: {
          profileId: "prf_squarey",
          truncated: false,
          canResume: true,
          currentSessionId: "held-1",
          sessions: [
            { id: "held-1", title: "Held session", updatedAt: "2026-01-01", held: true },
            { id: "free-1", title: "Free session", updatedAt: "2026-01-02", held: false },
          ],
        },
      }}
      onLoadSessionSummaries={vi.fn(async () => undefined)}
      onResumePastSession={resume}
      onLoadSessionModel={vi.fn(async () => undefined)}
      onChangeSessionModel={vi.fn(async () => undefined)}
      onChangeSessionThinking={vi.fn(async () => undefined)}
      onConnect={vi.fn(async () => undefined)}
      onOpenChange={vi.fn()}
      onSaveModel={vi.fn(async () => undefined)}
      onRetrySettings={vi.fn(async () => undefined)}
      onToggleExtension={vi.fn(async () => undefined)}
    />,
  );
  const section = screen.getByRole("region", { name: "Resume past session" });
  expect(section.textContent).toContain("Held session");
  expect(section.textContent).toContain("Held");
  const buttons = screen.getAllByRole("button", { name: "Resume" });
  expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(buttons[1]!);
  expect(resume).toHaveBeenCalledExactlyOnceWith("free-1");
});

it("shows quarantined extension diagnostics and the resident restart hint", () => {
  render(
    <SettingsDialog
      connected
      connectionPending={false}
      open
      profileName="Squarey"
      sessionModel={{ pending: false }}
      sessionBusy={false}
      modelSettings={{
        ...modelSettings,
        extensions: {
          profileId: "prf_squarey",
          available: [],
          selected: ["broken-one"],
          truncated: false,
          skipped: [
            {
              id: "broken-one",
              diagnostics: [
                { source: "broken-one/index.ts", message: "invalid command registration" },
              ],
            },
          ],
        },
      }}
      onConnect={vi.fn(async () => undefined)}
      onOpenChange={vi.fn()}
      onSaveModel={vi.fn(async () => undefined)}
      onRetrySettings={vi.fn(async () => undefined)}
      onToggleExtension={vi.fn(async () => undefined)}
      onLoadSessionModel={vi.fn(async () => undefined)}
      onChangeSessionModel={vi.fn(async () => undefined)}
      onChangeSessionThinking={vi.fn(async () => undefined)}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("invalid command registration");
  expect(screen.getByRole("alert").textContent).toContain(
    "Some packages were skipped. Fix them, then restart the resident.",
  );
  expect((screen.getByRole("switch", { name: "broken-one" }) as HTMLInputElement).checked).toBe(
    true,
  );
});
