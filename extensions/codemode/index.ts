/* oxlint-disable ziggy-effect/no-native-promise-ownership, ziggy-effect/no-effect-execution-boundary -- Pi tool and lifecycle hooks are this optional package's approved Effect execution edges. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { createCodeModeSession, executeCodeMode } from "./src/runtime.ts";

const Parameters = Type.Object(
  {
    code: Type.String({
      description: "JavaScript body for the confined MCP orchestration interpreter.",
      minLength: 1,
      maxLength: 128 * 1024,
    }),
  },
  { additionalProperties: false },
);

export default function codeMode(pi: Pick<ExtensionAPI, "on" | "registerTool">): void {
  const session = createCodeModeSession();

  pi.on("session_shutdown", async () => {
    await Effect.runPromise(session.close());
  });

  pi.registerTool({
    name: "codemode_execute",
    label: "codemode_execute",
    description:
      "Run bounded JavaScript orchestration over MCP stdio tools explicitly allowed in Profile codemode.json. If that file is missing, create it first (see the codemode-setup skill or package README for schema and security rules). Supports await, data, conditionals, while and for...of, safe helpers, and tools.$codemode.search. Classic for loops and try/catch are not supported. This AST interpreter is not eval or a general JavaScript runtime.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_toolCallId, { code }, signal, _onUpdate, ctx) {
      const details = await Effect.runPromise(executeCodeMode(session, ctx.cwd, code), { signal });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      };
    },
  });
}

export { createCodeModeSession, executeCodeMode } from "./src/runtime.ts";
