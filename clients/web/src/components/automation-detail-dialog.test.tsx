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
        detail={detail}
        destinations={[]}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onResolveDestination={vi.fn()}
        onSave={vi.fn()}
        open
      />,
    );

    expect(screen.getByText("Check today's weather.")).not.toBeNull();
    expect(screen.getAllByText("495 ms").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ProviderCallError").length).toBeGreaterThan(0);
    expect(screen.getByText("Last scheduler tick succeeded")).not.toBeNull();
    expect(document.body.textContent).toMatch(/EDT|EST|GMT-4/);
  });

  it("adds a resolved conversation while preserving an external broadcast", async () => {
    const onSave = vi.fn(async (_source: string, _expectedSource: string) => undefined);
    const destinationDetail: AutomationDetail = {
      ...detail,
      definition: {
        ...detail.definition!,
        source:
          "---\ncron: 0 8 * * *\ntimezone: UTC\nbroadcast: slack:channel:C0123\n---\nPost the update.\n",
      },
    };
    render(
      <AutomationDetailDialog
        automation={automation}
        available
        detail={destinationDetail}
        destinations={[
          {
            ref: {
              profileId: "prf_squarey",
              kind: "live",
              key: "discord/team-updates",
            },
            title: "Team updates",
            subtitle: "Discord conversation",
          },
        ]}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onResolveDestination={vi.fn(async () => "conversation:session-123")}
        onSave={onSave}
        open
      />,
    );

    fireEvent.change(screen.getByLabelText("Conversation"), {
      target: { value: "live:discord/team-updates" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add destination" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const source = onSave.mock.calls[0]?.[0];
    expect(source).toContain("broadcast: slack:channel:C0123,conversation:session-123\n");
  });
});
