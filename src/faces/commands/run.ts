import { Effect } from "effect";
import { ZiggyAgent } from "../../session";
import { ZiggyPaths } from "../../platform/paths";
import { Models, resolveProfileTarget } from "../../profile";
import { Sessions } from "../../session";
import { runAcp } from "../acp";
import type { CliCommand } from "../cli-command";

export type RunCommand = Extract<CliCommand, { readonly _tag: "Run" | "Acp" }>;

export const runRunCommand = (command: RunCommand) =>
  Effect.gen(function* () {
    const agent = yield* ZiggyAgent;
    const models = yield* Models;
    const sessions = yield* Sessions;
    const paths = yield* ZiggyPaths;

    switch (command._tag) {
      case "Run": {
        const target = resolveProfileTarget(command.target, paths);

        const sessionPath =
          command.sessionId === undefined
            ? undefined
            : (yield* sessions.locate(target, command.sessionId)).file;

        const exitCode = yield* agent.runOnce(
          target,
          command.prompt,
          command.continueSession,
          { kind: "local" },
          sessionPath === undefined
            ? { mode: command.json ? "json" : "text" }
            : { mode: command.json ? "json" : "text", sessionPath },
        );

        return exitCode;
      }

      case "Acp":
        return yield* runAcp(
          resolveProfileTarget(command.target, paths),
          command.shared,
          agent,
          models,
          command.agent,
        );
    }
  });
