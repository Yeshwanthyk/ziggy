// The authoritative progress is a sequence of phases, not a list of tool calls.
export interface TurnStep {
  readonly id: string;
  readonly title: string;
  readonly status: "in_progress" | "complete" | "error";
  readonly details?: string;
  readonly count: number;
  readonly category: string;
  readonly active: number;
  readonly files: ReadonlyArray<string>;
}

export interface TurnProgress {
  readonly headline: string;
  readonly steps: ReadonlyArray<TurnStep>;
  readonly toolCount: number;
  readonly calls: Readonly<Record<string, { readonly stepId: string; readonly open: boolean }>>;
  readonly startedAt: number;
  readonly queued: boolean;
  readonly phase: string;
  readonly terminal: boolean;
}

export type TurnProgressEvent =
  | { readonly kind: "start"; readonly atMs: number; readonly queued: boolean }
  | { readonly kind: "active"; readonly atMs: number }
  | { readonly kind: "tick"; readonly atMs: number }
  | { readonly kind: "thinking"; readonly atMs: number }
  | {
      readonly kind: "tool";
      readonly atMs: number;
      readonly toolCallId: string;
      readonly phase: "start" | "update" | "end";
      readonly category: string;
      readonly failed: boolean;
      readonly detail?: string;
    }
  | { readonly kind: "steer"; readonly atMs: number; readonly excerpt: string }
  | { readonly kind: "specialist"; readonly atMs: number; readonly agentId: string }
  | {
      readonly kind: "finish";
      readonly atMs: number;
      readonly outcome: "done" | "stopped" | "failed";
    };

const bounded = (value: string, limit: number): string =>
  [...value.replace(/\s+/gu, " ").trim()].slice(0, limit).join("");

const elapsed = (start: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes = Math.floor(seconds / 60);

  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
};

const headline = (progress: TurnProgress, atMs: number): string =>
  progress.queued
    ? "Queued behind an earlier request"
    : `${progress.phase} · ${elapsed(progress.startedAt, atMs)}`;

const fileName = (detail: string | undefined): string | undefined => {
  if (detail === undefined) return undefined;
  const match = /(?:^|\s)(?:[^\s]*\/)?([\w.-]+\.[\w]+)(?:\s|$)/u.exec(detail);

  return match?.[1];
};

const completedTitle = (step: TurnStep): string => {
  const { category, count } = step;

  if (category === "Reading a file") return `Read ${count} ${count === 1 ? "file" : "files"}`;

  if (category === "Running tests") return count === 1 ? "Ran tests" : `Ran tests ${count} times`;

  if (category === "Editing a file") {
    if (step.files.length > 0)
      return `Edited ${step.files.slice(0, 2).join(", ")}${count > step.files.slice(0, 2).length ? `, +${count - step.files.slice(0, 2).length}` : ""}`;

    return `Edited ${count} ${count === 1 ? "file" : "files"}`;
  }

  if (category === "Writing a file") return `Wrote ${count} ${count === 1 ? "file" : "files"}`;

  if (category === "Checking code") return "Checked code";

  if (category === "Building the project") return "Built the project";

  if (category === "Inspecting Git changes") return "Inspected Git changes";

  if (category === "Searching files") return "Searched files";

  if (category === "Exploring files") return "Explored files";

  if (category === "Running a command")
    return count === 1 ? "Ran a command" : `Ran ${count} commands`;

  if (category === "Consulting a specialist") return "Consulted a specialist";

  if (category === "Gathering specialist perspectives") return "Gathered specialist perspectives";

  if (category === "Checking reminders") return "Checked reminders";

  if (category === "Updating memory") return "Updated memory";

  return category.startsWith("Using ") ? `Used ${category.slice(6)}` : category;
};

export const reduceTurnProgress = (
  previous: TurnProgress | undefined,
  event: TurnProgressEvent,
): TurnProgress => {
  if (event.kind === "start") {
    const initial: TurnProgress = {
      headline: "",
      steps: [],
      toolCount: 0,
      calls: {},
      startedAt: event.atMs,
      queued: event.queued,
      phase: "Thinking",
      terminal: false,
    };

    return { ...initial, headline: headline(initial, event.atMs) };
  }

  if (previous === undefined)
    return reduceTurnProgress(undefined, { kind: "start", atMs: event.atMs, queued: false });

  if (previous.terminal) return previous;

  if (event.kind === "finish") {
    const time = elapsed(previous.startedAt, event.atMs);
    const count = previous.steps.length;

    return {
      ...previous,
      terminal: true,
      headline:
        event.outcome === "done"
          ? `Done in ${time} · ${count} ${count === 1 ? "step" : "steps"}`
          : event.outcome === "stopped"
            ? `Stopped after ${time}`
            : `Couldn't finish · ${time}`,
      steps: previous.steps.map((step) =>
        step.status === "in_progress"
          ? { ...step, status: "error", active: 0, details: "Interrupted before completion" }
          : step,
      ),
    };
  }

  if (event.kind === "active" || event.kind === "thinking") {
    const next = { ...previous, queued: false, phase: "Thinking" };

    return { ...next, headline: headline(next, event.atMs) };
  }

  if (event.kind === "tick") return { ...previous, headline: headline(previous, event.atMs) };

  if (event.kind === "steer" || event.kind === "specialist") {
    const title =
      event.kind === "steer"
        ? `Picked up your note: “${bounded(event.excerpt, 48)}”`
        : `Asked ${bounded(event.agentId, 40)}`;

    const step: TurnStep = {
      id: `step-${previous.steps.length + 1}`,
      category: event.kind,
      title,
      status: "complete",
      count: 1,
      active: 0,
      files: [],
    };

    return { ...previous, steps: [...previous.steps, step] };
  }

  const call = previous.calls[event.toolCallId];

  // Updates and ends without a known start cannot create a phantom phase. Replayed
  // starts/ends likewise cannot increment the count or undo an error.
  if (event.phase !== "start" && (!call || !call.open)) return previous;

  if (event.phase === "start" && call) return previous;

  const category = bounded(event.category, 80);

  const step =
    event.phase === "start"
      ? (previous.steps.findLast((item) => item.category === category && item.active > 0) ??
        (previous.steps.at(-1)?.category === category ? previous.steps.at(-1) : undefined))
      : previous.steps.find((item) => item.id === call?.stepId);

  if (event.phase !== "start" && step === undefined) return previous;
  const id = step?.id ?? `step-${previous.steps.length + 1}`;
  const count = (step?.count ?? 0) + (event.phase === "start" ? 1 : 0);

  const active =
    (step?.active ?? 0) + (event.phase === "start" ? 1 : event.phase === "end" ? -1 : 0);

  const failed = event.failed || step?.status === "error";
  const status = failed ? "error" : active === 0 ? "complete" : "in_progress";
  const name = event.phase === "start" ? fileName(event.detail) : undefined;

  const files =
    name === undefined || step?.files.includes(name)
      ? (step?.files ?? [])
      : [...(step?.files ?? []), name];

  const nextStep: TurnStep = {
    id,
    category: step?.category ?? category,
    count,
    active,
    files,
    status,
    title: failed
      ? `${step?.category ?? category}: failed`
      : active === 0
        ? bounded(
            completedTitle({
              id,
              category: step?.category ?? category,
              count,
              active,
              files,
              status,
              title: "",
            }),
            80,
          )
        : (step?.category ?? category),
    ...(failed
      ? { details: bounded(event.failed ? "Failed" : (step?.details ?? "Failed"), 120) }
      : undefined),
  };

  const steps =
    step === undefined
      ? [...previous.steps, nextStep]
      : previous.steps.map((item) => (item.id === id ? nextStep : item));

  const calls =
    event.phase === "update"
      ? previous.calls
      : {
          ...previous.calls,
          [event.toolCallId]: { stepId: id, open: event.phase === "start" },
        };

  const next = {
    ...previous,
    queued: false,
    steps,
    calls,
    toolCount: previous.toolCount + (event.phase === "start" ? 1 : 0),
    phase: event.phase === "end" && active === 0 ? "Thinking" : category,
  };

  return { ...next, headline: headline(next, event.atMs) };
};
