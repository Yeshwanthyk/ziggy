/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-error-constructor -- The component test owns a rejected save fixture at the UI boundary. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefinitionEditor } from "./definition-editor";

const source = [
  "---",
  "version: 1",
  "cron: 0 8 * * *",
  "timezone: America/Toronto",
  "broadcast: none",
  "x-note: keep this",
  "---",
  "",
  "Original task.",
  "",
].join("\n");

afterEach(cleanup);

describe("DefinitionEditor", () => {
  it("edits agent fields and preserves comma-separated tools", async () => {
    const agentSource = [
      "---",
      "version: 1",
      "description: Careful researcher",
      "tools: read, bash",
      "---",
      "",
      "Research carefully.",
      "",
    ].join("\n");
    const onSave = vi.fn(async (_nextSource: string, _expectedSource: string) => undefined);
    render(
      <DefinitionEditor kind="agent" onCancel={vi.fn()} onSave={onSave} source={agentSource} />,
    );

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Evidence-first researcher" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0]).toContain("description: Evidence-first researcher");
    expect(onSave.mock.calls[0]?.[0]).toContain("tools: read, bash");
    expect(onSave).toHaveBeenCalledWith(expect.any(String), agentSource);
  });

  it("does not overwrite full source edits when the active mode is clicked", () => {
    render(<DefinitionEditor onCancel={vi.fn()} onSave={vi.fn()} source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "Full source" }));
    const editor = screen.getByLabelText("Full automation definition");
    fireEvent.change(editor, { target: { value: `${source}# raw edit` } });

    fireEvent.click(screen.getByRole("button", { name: "Full source" }));

    expect((screen.getByLabelText("Full automation definition") as HTMLTextAreaElement).value).toBe(
      `${source}# raw edit`,
    );
  });

  it("preserves the edited draft and expected source after a failed CAS save", async () => {
    const onSave = vi.fn(async (_nextSource: string, _expectedSource: string) => {
      throw new Error("Definition changed on disk. Refresh before saving again.");
    });
    render(<DefinitionEditor onCancel={vi.fn()} onSave={onSave} source={source} />);

    const task = screen.getByLabelText("Task");
    fireEvent.change(task, { target: { value: "Edited task." } });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("changed on disk"));
    expect((screen.getByLabelText("Task") as HTMLTextAreaElement).value).toBe("Edited task.");
    expect(onSave).toHaveBeenCalledWith(expect.stringContaining("Edited task."), source);
    expect(onSave.mock.calls[0]?.[0]).toContain("x-note: keep this");
  });
});
