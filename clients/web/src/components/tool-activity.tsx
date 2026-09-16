import type { ReactNode } from "react";

export function groupCompletedActivity<T>(
  entries: readonly T[],
  isCompleted: (entry: T) => boolean,
): T[][] {
  const groups: T[][] = [];
  let completed: T[] | undefined;
  for (const entry of entries) {
    if (isCompleted(entry)) {
      if (completed === undefined) {
        completed = [];
        groups.push(completed);
      }
      completed.push(entry);
    } else {
      completed = undefined;
      groups.push([entry]);
    }
  }
  return groups;
}

export function ToolActivity({ count, children }: { count: number; children: ReactNode }) {
  if (count < 2) return children;
  return (
    <details className="tool-activity">
      <summary>{count} tool calls completed</summary>
      <div className="tool-activity-details">{children}</div>
    </details>
  );
}
