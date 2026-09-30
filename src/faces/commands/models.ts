import { Console, Effect, Match } from "effect";
import { Models } from "../../application/models";
import { ZiggyPaths } from "../../application/ziggy-paths";
import type { CliCommand } from "../cli-command";
import { renderModelSelection, renderModels, renderModelStatus } from "../models-cli";

export type ModelsCommand = Extract<
  CliCommand,
  { readonly _tag: "ModelsStatus" | "ModelsList" | "ModelsSet" }
>;

export const runModelsCommand = (command: ModelsCommand) =>
  Effect.gen(function* () {
    const models = yield* Models;
    const paths = yield* ZiggyPaths;

    return yield* Match.valueTags(command, {
      ModelsStatus: (command) =>
        models
          .status(paths.resolveTarget(command.target))
          .pipe(Effect.flatMap((status) => Console.log(renderModelStatus(status)))),
      ModelsList: (command) =>
        models
          .list(paths.resolveTarget(command.target), command.providerId)
          .pipe(Effect.flatMap((listed) => Console.log(renderModels(listed)))),
      ModelsSet: (command) =>
        models
          .set(
            paths.resolveTarget(command.target),
            command.providerId,
            command.modelId,
            command.thinking,
          )
          .pipe(Effect.flatMap((selection) => Console.log(renderModelSelection(selection)))),
    });
  });
