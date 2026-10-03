import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureConnector } from "./gallery/fixture-gateway";
import { App, HistoryEntry } from "./App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("HistoryEntry", () => {
  it("renders an automation result with its automation identity", () => {
    render(
      <HistoryEntry
        assistantName="Squarey"
        entry={{
          kind: "automation-result",
          automationId: "daily-report",
          runId: "run-1",
          text: "The report is ready.",
          timestamp: "2026-09-17T12:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Automation · daily-report")).not.toBeNull();
    expect(screen.getByText("The report is ready.")).not.toBeNull();
  });
});

it("shows the attachment count on image-only history entries", () => {
  render(
    <HistoryEntry
      assistantName="Ziggy"
      entry={{ kind: "user", timestamp: "2026-09-30T12:00:00Z", text: "", imageCount: 2 }}
    />,
  );
  expect(screen.getByText("2 images")).not.toBeNull();
});

it("attaches through file selection, paste and drop, removes previews, and sends images without text", async () => {
  let nextUrl = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:attachment-${++nextUrl}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const { container } = render(
    <App connection={{ connector: fixtureConnector("empty"), url: "ws://gallery.invalid/ws" }} />,
  );
  const send = screen.getByRole("button", { name: "Send message" });
  const attach = screen.getByRole("button", { name: "Attach images" });
  await waitFor(() => expect(attach.hasAttribute("disabled")).toBe(false));
  const file = (name: string) => new File(["fixture"], name, { type: "image/png" });
  const first = file("first.png");
  fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: [first] } });
  expect(screen.getByAltText("first.png")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove first.png" }));
  expect(revoke).toHaveBeenCalledWith("blob:attachment-1");
  fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: [first] } });
  const pasted = file("pasted.png");
  fireEvent.paste(screen.getByRole("textbox", { name: "Message Squarey" }), {
    clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pasted }] },
  });
  const panel = container.querySelector(".composer-panel");
  expect(panel).not.toBeNull();
  if (panel === null) throw new Error("Missing composer panel");
  fireEvent.drop(panel, { dataTransfer: { files: [file("dropped.png")] } });
  expect(screen.getByAltText("pasted.png")).not.toBeNull();
  expect(screen.getByAltText("dropped.png")).not.toBeNull();
  fireEvent.change(screen.getByLabelText("Choose images"), {
    target: { files: [new File(["bad"], "text.txt", { type: "text/plain" })] },
  });
  expect(screen.getByRole("alert").textContent).toContain("Use a PNG");
  fireEvent.change(screen.getByLabelText("Choose images"), {
    target: {
      files: [
        new File([new Uint8Array(5 * 1_024 * 1_024 + 1)], "large.png", { type: "image/png" }),
      ],
    },
  });
  expect(screen.getByRole("alert").textContent).toContain("5 MiB");
  fireEvent.change(screen.getByLabelText("Choose images"), {
    target: { files: [file("fourth.png"), file("fifth.png")] },
  });
  expect(screen.getByRole("alert").textContent).toContain("up to 4 images");
  expect(screen.queryByAltText("fifth.png")).toBeNull();
  expect(send.hasAttribute("disabled")).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(container.querySelectorAll(".attachment-preview")).toHaveLength(0));
  expect(container.querySelectorAll(".optimistic .message-images img")).toHaveLength(4);
  expect(revoke).toHaveBeenCalledWith("blob:attachment-2");
});
