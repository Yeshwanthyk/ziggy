/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Pi tool execution is the package's required Promise adapter boundary. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw -- The Pi boundary converts index failures to stable tool results. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  describeProfileSession,
  expandProfileQuery,
  listProfileSessions,
  searchProfileSessions,
} from "./src/store.ts";

const LimitParameter = Type.Optional(
  Type.Number({
    description: "Maximum number of results.",
    minimum: 1,
    maximum: 100,
    multipleOf: 1,
  }),
);

const SessionFilterParameter = Type.Optional(
  Type.String({
    description: "Restrict results to one Pi session header ID.",
    minLength: 1,
  }),
);

const jsonResult = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  details: payload,
});

const toolFailure = () =>
  jsonResult({
    error: "Lossless Claw could not read the persisted session index.",
  });

const runTool = <Result>(operation: () => Result) => {
  try {
    return jsonResult(operation());
  } catch {
    return toolFailure();
  }
};

export default function losslessClaw(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "lcm_sessions",
    label: "lcm_sessions",
    description: "List persisted Pi sessions indexed for recall, newest first.",
    parameters: Type.Object({
      limit: LimitParameter,
      since: Type.Optional(
        Type.String({
          description: "Only include sessions active at or after this ISO timestamp.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return runTool(() => listProfileSessions(ctx.cwd, parameters));
    },
  });

  pi.registerTool({
    name: "lcm_grep",
    label: "lcm_grep",
    description:
      "Search parsed message, tool-call, tool-result, compaction, and branch-summary text with BM25.",
    parameters: Type.Object({
      query: Type.String({ description: "Distinctive terms to search for.", minLength: 1 }),
      limit: LimitParameter,
      role: Type.Optional(Type.String({ description: "Restrict results to one message role." })),
      session: SessionFilterParameter,
      since: Type.Optional(
        Type.String({ description: "Only include entries at or after this ISO timestamp." }),
      ),
      until: Type.Optional(
        Type.String({ description: "Only include entries at or before this ISO timestamp." }),
      ),
      activeOnly: Type.Optional(
        Type.Boolean({
          description: "Only search entries on each session's current active branch.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return runTool(() => searchProfileSessions(ctx.cwd, parameters));
    },
  });

  pi.registerTool({
    name: "lcm_expand_query",
    label: "lcm_expand_query",
    description: "Search persisted Pi sessions and return bounded neighboring evidence.",
    parameters: Type.Object({
      query: Type.String({ description: "Distinctive terms to search for.", minLength: 1 }),
      limit: LimitParameter,
      session: SessionFilterParameter,
      context: Type.Optional(
        Type.Number({
          description: "Neighboring indexed entries to include on each side.",
          minimum: 1,
          maximum: 10,
          multipleOf: 1,
        }),
      ),
      activeOnly: Type.Optional(
        Type.Boolean({
          description: "Only search entries on each session's current active branch.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, parameters, _signal, _onUpdate, ctx) {
      return runTool(() => expandProfileQuery(ctx.cwd, parameters));
    },
  });

  pi.registerTool({
    name: "lcm_describe",
    label: "lcm_describe",
    description: "Describe one persisted Pi session by header ID or indexed path.",
    parameters: Type.Object({
      session: Type.String({
        description: "Pi session header ID or path beneath the Profile.",
        minLength: 1,
      }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, { session }, _signal, _onUpdate, ctx) {
      return runTool(() => {
        const description = describeProfileSession(ctx.cwd, session);
        return description ?? { error: `No indexed Pi session matches ${session}.` };
      });
    },
  });
}
