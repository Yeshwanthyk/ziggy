import { Console, Effect, Match } from "effect";
import { Sessions } from "../../application/sessions";
import { ZiggyPaths } from "../../platform/paths";
import type { CliCommand } from "../cli-command";
import {
  renderSession,
  renderSessionJson,
  renderSessionList,
  renderSessionListJson,
} from "../sessions-cli";
import { resolveProfileTarget } from "../../profile";

export type SessionsCommand = Extract<
  CliCommand,
  { readonly _tag: "SessionsList" | "SessionsShow" }
>;

export const runSessionsCommand = (command: SessionsCommand) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const paths = yield* ZiggyPaths;

    return yield* Match.valueTags(command, {
      SessionsList: (command) =>
        sessions
          .list(resolveProfileTarget(command.target, paths))
          .pipe(
            Effect.flatMap((listed) =>
              Console.log(command.json ? renderSessionListJson(listed) : renderSessionList(listed)),
            ),
          ),
      SessionsShow: (command) =>
        sessions
          .show(resolveProfileTarget(command.target, paths), command.reference)
          .pipe(
            Effect.flatMap((shown) =>
              Console.log(command.json ? renderSessionJson(shown) : renderSession(shown)),
            ),
          ),
    });
  });
