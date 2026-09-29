// The authoritative progress is a sequence of phases, not a list of tool calls.
export interface TurnStep {
  readonly id: string;
  readonly title: string;
  readonly status: "in_progress" | "complete" | "error";
  readonly details?: string;
  readonly count: number;
  readonly category: string;
  readonly active: number;
}

export interface TurnProgress {
  readonly headline: string;
  readonly steps: ReadonlyArray<TurnStep>;
  readonly toolCount: number;
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

const completedTitle = (category: string, count: number): string => {
  if (category === "Reading a file") return `Read ${count} ${count === 1 ? "file" : "files"}`;

  if (category === "Running tests") return count === 1 ? "Ran tests" : `Ran tests ${count} times`;

  if (category === "Editing a file") return `Edited ${count} ${count === 1 ? "file" : "files"}`;

  return `${category} · ${count}`;
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

    return {
      ...previous,
      terminal: true,
      headline:
        event.outcome === "done"
          ? `Done in ${time} · ${previous.toolCount} steps`
          : event.outcome === "stopped"
            ? `Stopped after ${time}`
            : `Couldn't finish · ${time}`,
      steps: previous.steps.map((step) =>
        step.status === "in_progress" ? { ...step, status: "complete" } : step,
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
    };

    return { ...previous, steps: [...previous.steps, step] };
  }

  const category = bounded(event.category, 80);
  const last = previous.steps.at(-1);
  const same = last?.category === category;
  const count = event.phase === "start" ? (same ? last.count + 1 : 1) : same ? last.count : 1;

  const active =
    event.phase === "start"
      ? same
        ? last.active + 1
        : 1
      : Math.max(0, (same ? last.active : 1) - (event.phase === "end" ? 1 : 0));

  const status =
    event.failed || (same && last.status === "error")
      ? "error"
      : active === 0
        ? "complete"
        : "in_progress";

  const title =
    status === "error" && last?.status === "error" && !event.failed
      ? last.title
      : event.failed
        ? bounded(`${category}: ${event.detail ?? "didn't complete"}`, 80)
        : event.phase === "end"
          ? bounded(completedTitle(category, count), 80)
          : category;

  const step: TurnStep = {
    id: same && last !== undefined ? last.id : `step-${previous.steps.length + 1}`,
    category,
    title,
    status,
    count,
    active,
    ...(status === "error"
      ? { details: bounded(event.detail ?? last?.details ?? "Didn't complete", 120) }
      : undefined),
  };

  const steps = same ? [...previous.steps.slice(0, -1), step] : [...previous.steps, step];

  const next = {
    ...previous,
    queued: false,
    steps,
    toolCount: previous.toolCount + (event.phase === "start" ? 1 : 0),
    phase: event.phase === "end" && active === 0 ? "Thinking" : category,
  };

  return { ...next, headline: headline(next, event.atMs) };
};
