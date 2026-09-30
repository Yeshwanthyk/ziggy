import { Console, Effect, Match } from "effect";
import { Memory } from "../../application/memory";
import { resolveProfileTarget } from "../../domain/profile";
import { ZiggyPaths } from "../../platform/paths";
import { parseMemoryScopeReference } from "../../domain/memory";
import type { CliCommand } from "../cli-command";
import {
  renderMemoryList,
  renderMemoryListJson,
  renderMemoryShow,
  renderMemoryShowJson,
} from "../memory-cli";

export type MemoryCommand = Extract<CliCommand, { readonly _tag: "MemoryList" | "MemoryShow" }>;

export const runMemoryCommand = (command: MemoryCommand) =>
  Effect.gen(function* () {
    const memory = yield* Memory;
    const paths = yield* ZiggyPaths;

    return yield* Match.valueTags(command, {
      MemoryList: (command) =>
        memory
          .list(resolveProfileTarget(command.target ?? ".", paths))
          .pipe(
            Effect.flatMap((listed) =>
              Console.log(command.json ? renderMemoryListJson(listed) : renderMemoryList(listed)),
            ),
          ),
      MemoryShow: (command) =>
        memory
          .show(
            resolveProfileTarget(command.target, paths),
            parseMemoryScopeReference(command.scope),
          )
          .pipe(
            Effect.flatMap((shown) =>
              Console.log(command.json ? renderMemoryShowJson(shown) : renderMemoryShow(shown)),
            ),
          ),
    });
  });
