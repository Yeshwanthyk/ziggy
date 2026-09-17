import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationDetailDialog } from "./automation-detail-dialog";
import type { AutomationDetail, AutomationSummary } from "@/gateway";

const automation: AutomationSummary = {
  id: "morning-weather",
  lifecycle: "active",
  schedule: "0 8 * * *",
  timezone: "America/Toronto",
};

const detail: AutomationDetail = {
  automationId: automation.id,
  definition: {
    profileId: "prf_squarey",
    id: automation.id,
    lifecycle: "active",
    source:
      "---\ncron: 0 8 * * *\ntimezone: America/Toronto\nbroadcast: none\n---\nCheck today's weather.",
  },
  errors: [],
  loading: false,
  runs: [
    {
      runId: "run-weather-1",
      automationId: automation.id,
      trigger: "scheduled",
      state: "failed",
      scheduledForMs: 1_757_937_600_000,
      recordedAtMs: 1_757_937_600_600,
      startedAtMs: 1_757_937_600_000,
      finishedAtMs: 1_757_937_600_495,
      failureCategory: "ProviderCallError",
      targets: [],
    },
  ],
  status: {
    profileId: "prf_squarey",
    observedAtMs: 1_757_937_700_000,
    heartbeatAtMs: 1_757_937_690_000,
    lastTickAtMs: 1_757_937_680_000,
    lastTickStatus: "ok",
    lastTickError: null,
    schedules: [],
    activeRunCount: 0,
    latestRun: null,
    latestErrorRun: null,
  },
};

afterEach(cleanup);

describe("AutomationDetailDialog", () => {
  it("renders timestamped run evidence without crashing and keeps subsecond precision", () => {
    render(
      <AutomationDetailDialog
        automation={automation}
        available
        detail={{
          ...detail,
          runs: [
            {
              ...detail.runs[0]!,
              targets: [
                {
                  target: "slack:channel:C012345678",
                  status: "failed",
                  failureCategory: "rate-limited",
                  retriable: true,
                },
              ],
            },
          ],
        }}
        destinations={[
          {
            target: "slack:channel:C012345678",
            kind: "slack",
            label: "Team updates",
            category: "slack",
            pinned: false,
          },
        ]}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onSave={vi.fn()}
        open
      />,
    );

    expect(screen.getByText("Check today's weather.")).not.toBeNull();
    expect(screen.getAllByText("495 ms").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ProviderCallError").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Team updates").length).toBeGreaterThan(0);
    expect(screen.getAllByText("failed · rate-limited").length).toBeGreaterThan(0);
    expect(screen.getByText("Last scheduler tick succeeded")).not.toBeNull();
    expect(document.body.textContent).toMatch(/EDT|EST|GMT-4/);
  });

  it("adds a conversation while preserving an external broadcast", async () => {
    const onSave = vi.fn(async (_source: string, _expectedSource: string) => undefined);
    const destinationDetail: AutomationDetail = {
      ...detail,
      definition: {
        ...detail.definition!,
        source:
          "---\ncron: 0 8 * * *\ntimezone: UTC\nbroadcast: slack:channel:C012345678\n---\nPost the update.\n",
      },
    };
    render(
      <AutomationDetailDialog
        automation={automation}
        available
        detail={destinationDetail}
        destinations={[
          {
            target: "conversation:session-123",
            kind: "conversation",
            label: "Team updates",
            category: "session",
            pinned: false,
            activityAt: "2026-09-17T12:00:00.000Z",
          },
        ]}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onSave={onSave}
        open
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select a destination" }));
    fireEvent.click(screen.getByRole("button", { name: /Team updates/u }));
    fireEvent.click(screen.getByRole("button", { name: "Add destination" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const source = onSave.mock.calls[0]?.[0];
    expect(source).toContain("broadcast: slack:channel:C012345678,conversation:session-123\n");
  });

  it("keeps saved targets missing from discovery visible and removable", async () => {
    const onSave = vi.fn(async (_source: string, _expectedSource: string) => undefined);
    render(
      <AutomationDetailDialog
        automation={automation}
        available
        detail={{
          ...detail,
          definition: {
            ...detail.definition!,
            source:
              "---\ncron: 0 8 * * *\ntimezone: UTC\nbroadcast: origin,telegram:chat:-100123\n---\nPost the update.\n",
          },
        }}
        destinations={[]}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onSave={onSave}
        open
      />,
    );

    expect(screen.getByText("telegram:chat:-100123")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove telegram:chat:-100123" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toContain("broadcast: origin\n");
  });

  it("features an active run above a newer skipped attempt and explains empty delivery state", () => {
    render(
      <AutomationDetailDialog
        automation={automation}
        available
        detail={{
          ...detail,
          runs: [
            {
              ...detail.runs[0]!,
              runId: "run-skipped",
              state: "skipped-busy",
              recordedAtMs: 1_757_937_601_000,
              startedAtMs: null,
              finishedAtMs: null,
              failureCategory: null,
            },
            {
              ...detail.runs[0]!,
              runId: "run-active",
              state: "running",
              recordedAtMs: 1_757_937_600_000,
              finishedAtMs: null,
              failureCategory: null,
            },
          ],
        }}
        destinations={[]}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onSave={vi.fn()}
        open
      />,
    );

    expect(screen.getByRole("heading", { name: "Active run" })).not.toBeNull();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByText("In progress")).not.toBeNull();
    expect(
      screen.getAllByText("Broadcast delivery waits for this run to finish.").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Skipped · already running")).not.toBeNull();
    expect(
      screen.getByText("This attempt did not start, so no broadcasts were attempted."),
    ).not.toBeNull();
  });
});
