import { Effect, Schema } from "effect";
import { CliInputInvalid, type CliCommand, type HelpTopic } from "../domain/cli";

const decodeArguments = Schema.decodeUnknownEffect(Schema.Array(Schema.String));

const helpTopics = new Set<string>([
  "help",
  "version",
  "init",
  "profiles",
  "skills",
  "extensions",
  "auth",
  "models",
  "agents",
  "run",
  "automations",
  "wake",
  "gateway",
  "tui",
]);

const isHelpTopic = (value: string): value is HelpTopic => helpTopics.has(value);

const reservedWords = new Set([
  ...helpTopics,
  "--help",
  "-h",
  "--version",
  "-V",
  "discord",
  "slack",
]);

const invalid = (message: string): CliInputInvalid => new CliInputInvalid({ message });

const required = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

const parseModelReference = (
  reference: string,
): { readonly providerId: string; readonly modelId: string } | undefined => {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return { providerId: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
};

const parseTypedArguments = (args: ReadonlyArray<string>): CliCommand | CliInputInvalid => {
  const [word, ...rest] = args;
  if (word === undefined) return { _tag: "Tui", target: "." };

  if (word === "help" || word === "--help" || word === "-h") {
    if (rest.length === 0) return { _tag: "Help" };
    if (rest.length === 1 && rest[0] !== undefined && isHelpTopic(rest[0])) {
      return { _tag: "Help", topic: rest[0] };
    }
    return invalid("usage: ziggy help [command]");
  }

  if (word === "version" || word === "--version" || word === "-V") {
    if (rest.length !== 0) return invalid("usage: ziggy version");
    return { _tag: "Version" };
  }

  if (word === "tui") {
    if (rest.length > 1) return invalid("usage: ziggy tui [<name|path>]");
    return { _tag: "Tui", target: rest[0] ?? "." };
  }

  if (word === "init") {
    if (rest.length !== 1 || !required(rest[0])) {
      return invalid("usage: ziggy init <name|path>");
    }
    return { _tag: "Init", target: rest[0] };
  }

  if (word === "profiles") {
    if (rest.length !== 0) return invalid("usage: ziggy profiles");
    return { _tag: "Profiles" };
  }

  if (word === "skills") {
    if (rest[0] === "list" && rest.length === 2 && required(rest[1])) {
      return { _tag: "SkillsList", target: rest[1] };
    }
    if (
      rest[0] === "add" &&
      (rest.length === 3 || (rest.length === 4 && rest[3] === "--force")) &&
      required(rest[1]) &&
      required(rest[2])
    ) {
      return { _tag: "SkillsAdd", target: rest[1], source: rest[2], force: rest.length === 4 };
    }
    return invalid(
      "usage:\n  ziggy skills list <name|path>\n  ziggy skills add <name|path> <id|path> [--force]",
    );
  }

  if (word === "extensions") {
    if (rest[0] === "list" && rest.length === 1) return { _tag: "ExtensionsList" };
    if (rest[0] === "show" && rest.length === 2 && required(rest[1])) {
      return { _tag: "ExtensionsShow", id: rest[1] };
    }
    if (
      (rest[0] === "add" || rest[0] === "remove") &&
      rest.length === 3 &&
      required(rest[1]) &&
      required(rest[2])
    ) {
      return {
        _tag: rest[0] === "add" ? "ExtensionsAdd" : "ExtensionsRemove",
        target: rest[1],
        id: rest[2],
      };
    }
    return invalid(
      "usage:\n  ziggy extensions list\n  ziggy extensions show <id>\n  ziggy extensions add <name|path> <id>\n  ziggy extensions remove <name|path> <id>",
    );
  }

  if (word === "auth") {
    if (rest.length === 1 && required(rest[0])) return { _tag: "AuthStatus", target: rest[0] };
    if (required(rest[0]) && required(rest[1])) {
      if (rest.length === 2) {
        return { _tag: "AuthLogin", target: rest[0], providerId: rest[1] };
      }
      if (
        rest.length === 4 &&
        rest[2] === "--type" &&
        (rest[3] === "api_key" || rest[3] === "oauth")
      ) {
        return {
          _tag: "AuthLogin",
          target: rest[0],
          providerId: rest[1],
          type: rest[3],
        };
      }
    }
    return invalid("usage: ziggy auth <name|path> [provider] [--type api_key|oauth]");
  }

  if (word === "models") {
    if (rest[0] === "status" && rest.length === 2 && required(rest[1])) {
      return { _tag: "ModelsStatus", target: rest[1] };
    }
    if (rest[0] === "list" && required(rest[1])) {
      if (rest.length === 2) return { _tag: "ModelsList", target: rest[1] };
      if (rest.length === 4 && rest[2] === "--provider" && required(rest[3])) {
        return { _tag: "ModelsList", target: rest[1], providerId: rest[3] };
      }
    }
    if (rest[0] === "set" && required(rest[1]) && required(rest[2])) {
      const model = parseModelReference(rest[2]);
      if (model !== undefined) {
        if (rest.length === 3) return { _tag: "ModelsSet", target: rest[1], ...model };
        if (rest.length === 5 && rest[3] === "--thinking" && required(rest[4])) {
          return {
            _tag: "ModelsSet",
            target: rest[1],
            ...model,
            thinking: rest[4],
          };
        }
      }
    }
    return invalid(
      "usage:\n  ziggy models status <name|path>\n  ziggy models list <name|path> [--provider <id>]\n  ziggy models set <name|path> <provider>/<model> [--thinking <level>]",
    );
  }

  if (word === "agents") {
    if (rest[0] === "create" && rest.length === 3 && required(rest[1]) && required(rest[2])) {
      return { _tag: "AgentsCreate", target: rest[1], agentId: rest[2] };
    }
    if (rest[0] === "list" && rest.length === 2 && required(rest[1])) {
      return { _tag: "AgentsList", target: rest[1] };
    }
    if (rest[0] === "show" && rest.length === 3 && required(rest[1]) && required(rest[2])) {
      return { _tag: "AgentsShow", target: rest[1], agentId: rest[2] };
    }
    if (rest[0] === "validate" && (rest.length === 2 || rest.length === 3) && required(rest[1])) {
      const agentId = rest[2];
      return agentId === undefined
        ? { _tag: "AgentsValidate", target: rest[1] }
        : { _tag: "AgentsValidate", target: rest[1], agentId };
    }
    if (rest[0] === "run" && required(rest[1]) && required(rest[2])) {
      const prompt = rest.slice(3).join(" ").trim();
      if (prompt.length > 0) {
        return { _tag: "AgentsRun", target: rest[1], agentId: rest[2], prompt };
      }
    }
    return invalid(
      "usage:\n  ziggy agents create <name|path> <agent-id>\n  ziggy agents list <name|path>\n  ziggy agents show <name|path> <agent-id>\n  ziggy agents validate <name|path> [agent-id]\n  ziggy agents run <name|path> <agent-id> <prompt...>",
    );
  }

  if (word === "run") {
    const continueSession = rest[0] === "-c" || rest[0] === "--continue";
    const targetIndex = continueSession ? 1 : 0;
    const target = rest[targetIndex];
    const promptParts = rest.slice(targetIndex + 1);
    if (
      !required(target) ||
      promptParts.length === 0 ||
      promptParts.join(" ").trim().length === 0
    ) {
      return invalid("usage: ziggy run [-c] <name|path> <prompt...>");
    }
    return { _tag: "Run", target, prompt: promptParts.join(" "), continueSession };
  }

  if (word === "automations") {
    if (rest[0] === "create" && rest.length === 3 && required(rest[1]) && required(rest[2])) {
      return { _tag: "AutomationsCreate", target: rest[1], automationId: rest[2] };
    }
    if (rest[0] === "list" && rest.length === 2 && required(rest[1])) {
      return { _tag: "AutomationsList", target: rest[1] };
    }
    if (rest[0] === "validate" && (rest.length === 2 || rest.length === 3) && required(rest[1])) {
      const automationId = rest[2];
      return automationId === undefined
        ? { _tag: "AutomationsValidate", target: rest[1] }
        : { _tag: "AutomationsValidate", target: rest[1], automationId };
    }
    if (rest[0] === "status" && rest.length === 2 && required(rest[1])) {
      return { _tag: "AutomationsStatus", target: rest[1] };
    }
    if (rest[0] === "runs" && (rest.length === 2 || rest.length === 3) && required(rest[1])) {
      const automationId = rest[2];
      return automationId === undefined
        ? { _tag: "AutomationsRuns", target: rest[1] }
        : { _tag: "AutomationsRuns", target: rest[1], automationId };
    }
    return invalid(
      "usage:\n  ziggy automations create <name|path> <automation-id>\n  ziggy automations list <name|path>\n  ziggy automations validate <name|path> [automation-id]\n  ziggy automations status <name|path>\n  ziggy automations runs <name|path> [automation-id]",
    );
  }

  if (word === "wake") {
    if (rest.length !== 2 || !required(rest[0]) || !required(rest[1])) {
      return invalid("usage: ziggy wake <name|path> <automation-id>");
    }
    return { _tag: "Wake", target: rest[0], automationId: rest[1] };
  }

  if (word === "gateway") {
    if (rest.length !== 1 || !required(rest[0])) {
      return invalid("usage: ziggy gateway <name|path>");
    }
    return { _tag: "Gateway", target: rest[0] };
  }

  if (word === "discord" || word === "slack") {
    return { _tag: "UnsupportedResidentAlias", name: word };
  }

  if (reservedWords.has(word) || word.startsWith("-")) {
    return invalid(`invalid ${word} command`);
  }
  if (rest.length !== 0) return invalid("usage: ziggy <name|path>");
  return { _tag: "Tui", target: word };
};

export const decodeCliCommand = (input: unknown): Effect.Effect<CliCommand, CliInputInvalid> =>
  decodeArguments(input).pipe(
    Effect.mapError(() => invalid("command arguments must be strings")),
    Effect.flatMap((args) => {
      const parsed = parseTypedArguments(args);
      return parsed._tag === "CliInputInvalid" ? Effect.fail(parsed) : Effect.succeed(parsed);
    }),
  );

const generalHelp = `Usage:
  ziggy [<name|path>]
  ziggy tui [<name|path>]
  ziggy run [-c] <name|path> <prompt...>
  ziggy init <name|path>
  ziggy profiles
  ziggy auth <name|path> [provider] [--type api_key|oauth]
  ziggy models status <name|path>
  ziggy models list <name|path> [--provider <id>]
  ziggy models set <name|path> <provider>/<model> [--thinking <level>]
  ziggy agents create|list|show|validate|run ...
  ziggy skills list <name|path>
  ziggy skills add <name|path> <id|path> [--force]
  ziggy extensions list|show|add|remove ...
  ziggy automations create|list|validate|status|runs ...
  ziggy wake <name|path> <automation-id>
  ziggy gateway <name|path>
  ziggy help [command]
  ziggy version`;

const topicHelp: Record<HelpTopic, string> = {
  help: "usage: ziggy help [command]",
  version: "usage: ziggy version",
  init: "usage: ziggy init <name|path>",
  profiles: "usage: ziggy profiles",
  skills:
    "usage:\n  ziggy skills list <name|path>\n  ziggy skills add <name|path> <id|path> [--force]",
  extensions:
    "usage:\n  ziggy extensions list\n  ziggy extensions show <id>\n  ziggy extensions add <name|path> <id>\n  ziggy extensions remove <name|path> <id>",
  auth: "usage: ziggy auth <name|path> [provider] [--type api_key|oauth]",
  models:
    "usage:\n  ziggy models status <name|path>\n  ziggy models list <name|path> [--provider <id>]\n  ziggy models set <name|path> <provider>/<model> [--thinking <level>]",
  agents:
    "usage:\n  ziggy agents create <name|path> <agent-id>\n  ziggy agents list <name|path>\n  ziggy agents show <name|path> <agent-id>\n  ziggy agents validate <name|path> [agent-id]\n  ziggy agents run <name|path> <agent-id> <prompt...>",
  run: "usage: ziggy run [-c] <name|path> <prompt...>",
  automations:
    "usage:\n  ziggy automations create <name|path> <automation-id>\n  ziggy automations list <name|path>\n  ziggy automations validate <name|path> [automation-id]\n  ziggy automations status <name|path>\n  ziggy automations runs <name|path> [automation-id]",
  wake: "usage: ziggy wake <name|path> <automation-id>",
  gateway: "usage: ziggy gateway <name|path>",
  tui: "usage: ziggy tui [<name|path>]",
};

export const renderHelp = (topic?: HelpTopic): string =>
  topic === undefined ? generalHelp : topicHelp[topic];
