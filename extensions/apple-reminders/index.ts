/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is this package's required Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- Pi requires rejected tool Promises to mark failed executions. */
/* oxlint-disable ziggy-effect/no-error-constructor -- Pi's tool boundary accepts Error failures, not Effect errors. */
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import scriptPath from "./scripts/reminders.applescript" with { type: "file" };

const OSASCRIPT = "/usr/bin/osascript";
const SCRIPT_PATH = scriptPath;
const TIMEOUT_MS = 45_000;
const OUTPUT_LIMIT = 32 * 1024;

const RequiredText = Type.String({ minLength: 1, maxLength: 1_024 });

const CalendarDate = Type.Object(
  {
    year: Type.Integer({ minimum: 1, maximum: 9_999 }),
    month: Type.Integer({ minimum: 1, maximum: 12 }),
    day: Type.Integer({ minimum: 1, maximum: 31 }),
  },
  { additionalProperties: false },
);

const AllDayDue = Type.Object(
  {
    kind: Type.Literal("all-day"),
    year: Type.Integer({ minimum: 1, maximum: 9_999 }),
    month: Type.Integer({ minimum: 1, maximum: 12 }),
    day: Type.Integer({ minimum: 1, maximum: 31 }),
  },
  { additionalProperties: false },
);

const TimedDue = Type.Object(
  {
    kind: Type.Literal("timed"),
    year: Type.Integer({ minimum: 1, maximum: 9_999 }),
    month: Type.Integer({ minimum: 1, maximum: 12 }),
    day: Type.Integer({ minimum: 1, maximum: 31 }),
    hour: Type.Integer({ minimum: 0, maximum: 23 }),
    minute: Type.Integer({ minimum: 0, maximum: 59 }),
  },
  { additionalProperties: false },
);

const Due = Type.Union([AllDayDue, TimedDue]);

const ListIncompleteParameters = Type.Object(
  {
    list: Type.Optional(RequiredText),
  },
  { additionalProperties: false },
);

const ListDueParameters = Type.Object(
  {
    date: CalendarDate,
    list: Type.Optional(RequiredText),
  },
  { additionalProperties: false },
);

const CreateParameters = Type.Object(
  {
    name: RequiredText,
    list: RequiredText,
    due: Type.Optional(Due),
  },
  { additionalProperties: false },
);

const RescheduleParameters = Type.Object(
  {
    name: RequiredText,
    source_list: Type.Optional(RequiredText),
    due: Due,
  },
  { additionalProperties: false },
);

const MoveParameters = Type.Object(
  {
    name: RequiredText,
    source_list: Type.Optional(RequiredText),
    destination_list: RequiredText,
  },
  { additionalProperties: false },
);

const CompleteParameters = Type.Object(
  {
    name: RequiredText,
    source_list: Type.Optional(RequiredText),
  },
  { additionalProperties: false },
);

const DeleteParameters = Type.Object(
  {
    name: RequiredText,
    source_list: RequiredText,
    confirmed: Type.Literal(true, {
      description: "Must be true only after the user explicitly confirmed this exact deletion.",
    }),
  },
  { additionalProperties: false },
);

type CalendarDateValue = Static<typeof CalendarDate>;
type DueValue = Static<typeof Due>;

export type AppleRemindersInvocation =
  | { readonly operation: "list-incomplete"; readonly list?: string }
  | { readonly operation: "list-due"; readonly date: CalendarDateValue; readonly list?: string }
  | {
      readonly operation: "create";
      readonly name: string;
      readonly list: string;
      readonly due?: DueValue;
    }
  | {
      readonly operation: "reschedule";
      readonly name: string;
      readonly source_list?: string;
      readonly due: DueValue;
    }
  | {
      readonly operation: "move";
      readonly name: string;
      readonly source_list?: string;
      readonly destination_list: string;
    }
  | {
      readonly operation: "complete";
      readonly name: string;
      readonly source_list?: string;
    }
  | {
      readonly operation: "delete";
      readonly name: string;
      readonly source_list: string;
      readonly confirmed: true;
    };

const assertCalendarDate = (date: CalendarDateValue): void => {
  const candidate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    candidate.getUTCFullYear() !== date.year ||
    candidate.getUTCMonth() !== date.month - 1 ||
    candidate.getUTCDate() !== date.day
  ) {
    throw new Error(`Invalid calendar date: ${date.year}-${date.month}-${date.day}`);
  }
};

const dueArguments = (due: DueValue | undefined): string[] => {
  if (due === undefined) return ["none", "0", "0", "0", "0", "0"];
  assertCalendarDate(due);
  return [
    due.kind,
    String(due.year),
    String(due.month),
    String(due.day),
    String(due.kind === "timed" ? due.hour : 0),
    String(due.kind === "timed" ? due.minute : 0),
  ];
};

export const appleRemindersArguments = (invocation: AppleRemindersInvocation): string[] => {
  switch (invocation.operation) {
    case "list-incomplete":
      return [invocation.operation, invocation.list ?? ""];
    case "list-due":
      assertCalendarDate(invocation.date);
      return [
        invocation.operation,
        String(invocation.date.year),
        String(invocation.date.month),
        String(invocation.date.day),
        invocation.list ?? "",
      ];
    case "create":
      return [
        invocation.operation,
        invocation.name,
        invocation.list,
        ...dueArguments(invocation.due),
      ];
    case "reschedule":
      return [
        invocation.operation,
        invocation.name,
        invocation.source_list ?? "",
        ...dueArguments(invocation.due),
      ];
    case "move":
      return [
        invocation.operation,
        invocation.name,
        invocation.source_list ?? "",
        invocation.destination_list,
      ];
    case "complete":
      return [invocation.operation, invocation.name, invocation.source_list ?? ""];
    case "delete":
      if (invocation.confirmed !== true) {
        throw new Error("Apple Reminders deletion requires explicit confirmation.");
      }
      return [invocation.operation, invocation.name, invocation.source_list, "confirmed"];
  }
};

const truncate = (text: string): string =>
  text.length <= OUTPUT_LIMIT
    ? text
    : `${text.slice(0, OUTPUT_LIMIT)}\n… ${text.length - OUTPUT_LIMIT} characters omitted`;

const resultText = (result: ExecResult): string => {
  const stdout = truncate(result.stdout.trim());
  const stderr = truncate(result.stderr.trim());
  if (stdout.length > 0 && stderr.length > 0) return `${stdout}\n\nstderr:\n${stderr}`;
  if (stdout.length > 0) return stdout;
  if (stderr.length > 0) return `stderr:\n${stderr}`;
  return "Apple Reminders command completed successfully.";
};

const isMutation = (operation: AppleRemindersInvocation["operation"]): boolean =>
  operation !== "list-incomplete" && operation !== "list-due";

export const runAppleReminders = async (
  exec: ExtensionAPI["exec"],
  invocation: AppleRemindersInvocation,
  cwd: string,
  signal: AbortSignal | undefined,
) => {
  const argv = appleRemindersArguments(invocation);
  const execOptions: Parameters<ExtensionAPI["exec"]>[2] = {
    cwd,
    timeout: TIMEOUT_MS,
  };
  if (signal !== undefined) {
    execOptions.signal = signal;
  }
  const result = await exec(OSASCRIPT, [SCRIPT_PATH, ...argv], execOptions);

  if (result.code !== 0) {
    const reason = result.killed ? "was terminated" : `exited with code ${result.code}`;
    const output = resultText(result);
    const mutationWarning = isMutation(invocation.operation)
      ? "\nThe mutation was not retried. Inspect Reminders before attempting another write."
      : "";
    throw new Error(`Apple Reminders ${reason}\n${output}${mutationWarning}`);
  }

  const text = resultText(result);
  return {
    content: [{ type: "text" as const, text }],
    details: {
      operation: invocation.operation,
      code: result.code,
      killed: result.killed,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
    },
  };
};

export const appleRemindersScriptPath = SCRIPT_PATH;

export default function appleReminders(pi: ExtensionAPI): void {
  const run = (
    invocation: AppleRemindersInvocation,
    cwd: string,
    signal: AbortSignal | undefined,
  ) => runAppleReminders(pi.exec.bind(pi), invocation, cwd, signal);

  pi.registerTool({
    name: "apple_reminders_list_incomplete",
    label: "apple_reminders_list_incomplete",
    description: "List incomplete Apple Reminders, optionally in one exact case-sensitive list.",
    parameters: ListIncompleteParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      return run({ operation: "list-incomplete", ...parameters }, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "apple_reminders_list_due",
    label: "apple_reminders_list_due",
    description:
      "List incomplete Apple Reminders due on one absolute local calendar date, optionally in one exact case-sensitive list.",
    parameters: ListDueParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      return run({ operation: "list-due", ...parameters }, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "apple_reminders_create",
    label: "apple_reminders_create",
    description:
      "Create exactly one Apple Reminder in an exact case-sensitive list, refusing an incomplete exact-name duplicate. Use absolute local date components only.",
    parameters: CreateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      return run({ operation: "create", ...parameters }, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "apple_reminders_reschedule",
    label: "apple_reminders_reschedule",
    description:
      "Reschedule exactly one incomplete exact-name Apple Reminder, preserving its list and verifying the absolute local due date after one write.",
    parameters: RescheduleParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      return run({ operation: "reschedule", ...parameters }, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "apple_reminders_move",
    label: "apple_reminders_move",
    description:
      "Check whether this macOS Reminders scripting interface can safely move a reminder between lists. It currently fails closed without writing because AppleScript does not persist list moves reliably.",
    parameters: MoveParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      return run({ operation: "move", ...parameters }, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "apple_reminders_complete",
    label: "apple_reminders_complete",
    description:
      "Complete exactly one incomplete exact-name Apple Reminder and verify its identity, list, and due fields after one write.",
    parameters: CompleteParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      return run({ operation: "complete", ...parameters }, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "apple_reminders_delete",
    label: "apple_reminders_delete",
    description:
      "Delete exactly one exact-name Apple Reminder from one exact case-sensitive list only after explicit user confirmation, then verify its ID is gone.",
    parameters: DeleteParameters,
    executionMode: "sequential",
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      return run({ operation: "delete", ...parameters }, ctx.cwd, signal);
    },
  });
}
