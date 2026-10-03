import { Console, Effect, Match } from "effect";
import { ZiggyPaths } from "../../platform/paths";
import type { CliCommand } from "../cli-command";
import { renderModelSelection, renderModels, renderModelStatus } from "../models-cli";
import { Models, resolveProfileTarget } from "../../profile";

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
          .status(resolveProfileTarget(command.target, paths))
          .pipe(Effect.flatMap((status) => Console.log(renderModelStatus(status)))),
      ModelsList: (command) =>
        models
          .list(resolveProfileTarget(command.target, paths), command.providerId)
          .pipe(Effect.flatMap((listed) => Console.log(renderModels(listed)))),
      ModelsSet: (command) =>
        models
          .set(
            resolveProfileTarget(command.target, paths),
            command.providerId,
            command.modelId,
            command.thinking,
          )
          .pipe(Effect.flatMap((selection) => Console.log(renderModelSelection(selection)))),
    });
  });
