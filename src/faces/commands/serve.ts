import { Effect } from "effect";
import { ResidentGateway } from "../../application/resident-gateway";
import { ZiggyPaths } from "../../platform/paths";
import { resolveProfileTarget } from "../../profile";
import type { CliCommand } from "../cli-command";

export type ServeCommand = Extract<CliCommand, { readonly _tag: "Serve" | "Gateway" }>;

/** Run the resident in the foreground until it is stopped. */
export const runServeCommand = (command: ServeCommand) =>
  Effect.gen(function* () {
    const residentGateway = yield* ResidentGateway;
    const paths = yield* ZiggyPaths;

    return yield* residentGateway.run(resolveProfileTarget(command.target, paths));
  });
