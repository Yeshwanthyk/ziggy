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
      "Run bounded JavaScript over MCP stdio tools allowed in Profile codemode.json (setup: codemode-setup skill or package README). Supports await, while and for...of; define functions with arrow functions. Rejects classic for, for...in, do...while, try/catch, throw, switch, and function declarations. Any MCP isError ends the script; there is no try/catch. Confined AST interpreter, not general JavaScript.",
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
