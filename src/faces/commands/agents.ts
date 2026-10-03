import { Effect } from "effect";
import { ProfileAgents } from "../../agents";
import { ZiggyPaths } from "../../platform/paths";
import { resolveProfileTarget } from "../../profile";
import {
  renderProfileAgent,
  renderProfileAgentJson,
  renderProfileAgents,
  renderProfileAgentsJson,
  renderProfileAgentValidation,
} from "../agents-cli";
import type { CliCommand } from "../cli-command";

export type AgentsCommand = Extract<
  CliCommand,
  { readonly _tag: "AgentsCreate" | "AgentsList" | "AgentsShow" | "AgentsValidate" | "AgentsRun" }
>;

export const runAgentsCommand = (command: AgentsCommand) =>
  Effect.gen(function* () {
    const profileAgents = yield* ProfileAgents;
    const paths = yield* ZiggyPaths;

    switch (command._tag) {
      case "AgentsCreate": {
        const created = yield* profileAgents.create(
          resolveProfileTarget(command.target, paths),
          command.agentId,
        );

        console.log(`created Profile agent ${created.id} at ${created.path}`);

        return;
      }

      case "AgentsList": {
        const listed = yield* profileAgents.list(resolveProfileTarget(command.target, paths));

        console.log(command.json ? renderProfileAgentsJson(listed) : renderProfileAgents(listed));

        return;
      }

      case "AgentsShow": {
        const shown = yield* profileAgents.show(
          resolveProfileTarget(command.target, paths),
          command.agentId,
        );

        console.log(command.json ? renderProfileAgentJson(shown) : renderProfileAgent(shown));

        return;
      }

      case "AgentsValidate": {
        const validation = yield* profileAgents.validate(
          resolveProfileTarget(command.target, paths),
          command.agentId,
        );

        console.log(renderProfileAgentValidation(validation));

        return validation.some((item) => !item.valid) ? 1 : 0;
      }

      case "AgentsRun": {
        const result = yield* profileAgents.run(
          resolveProfileTarget(command.target, paths),
          command.agentId,
          command.prompt,
        );

        console.log(result.answer);

        return;
      }
    }
  });
