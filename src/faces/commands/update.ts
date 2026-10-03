import { Effect } from "effect";
import { SelfUpdate } from "../../application/self-update";
import type { CliCommand } from "../cli-command";

export type UpdateCommand = Extract<CliCommand, { readonly _tag: "Update" }>;

export const runUpdateCommand = (command: UpdateCommand) =>
  Effect.gen(function* () {
    const selfUpdate = yield* SelfUpdate;

    switch (command._tag) {
      case "Update": {
        const updated = yield* selfUpdate.update();
        console.log(`updated Ziggy at ${updated.path} (${updated.version})`);

        return;
      }
    }
  });
