import { Effect, Predicate, Schema } from "effect";
import { CliInputInvalid, type CliCommand, type HelpTopic } from "../domain/cli";
import { MemoryScopeReference } from "../domain/memory";

const decodeMemoryScope = Schema.decodeUnknownEffect(MemoryScopeReference);

const helpTopics = new Set<string>([
  "help",
  "version",
  "update",
  "init",
  "profiles",
  "extensions",
  "auth",
  "models",
  "agents",
  "doctor",
  "run",
  "acp",
  "automations",
  "wake",
  "sessions",
  "memory",
  "serve",
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

const serveHelp = `usage:
  ziggy serve <name|path>
  ziggy serve install <name|path> [--force] [--no-start]
  ziggy serve start <name|path>
  ziggy serve stop <name|path>
  ziggy serve restart <name|path>
  ziggy serve status <name|path>
  ziggy serve logs <name|path> [--follow]
  ziggy serve uninstall <name|path>`;

const required = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

const parseModelReference = (
  reference: string,
): { readonly providerId: string; readonly modelId: string } | undefined => {
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return { providerId: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
};

const parseInit = (args: ReadonlyArray<string>): CliCommand | CliInputInvalid => {
  const target = args[0];
  if (!required(target)) return invalid("usage: ziggy init <name|path> [options]");
  let minimal = false;
  let nonInteractive = false;
  let providerId: string | undefined;
  let modelId: string | undefined;
  let thinking: string | undefined;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--minimal" || flag === "--non-interactive") {
      if (seen.has(flag)) return invalid(`duplicate init option ${flag}`);
      seen.add(flag);
      if (flag === "--minimal") minimal = true;
      else nonInteractive = true;
      continue;
    }
    if (flag === "--provider" || flag === "--model" || flag === "--thinking") {
      if (seen.has(flag)) return invalid(`duplicate init option ${flag}`);
      const value = args[index + 1];
      if (!required(value) || value.startsWith("--")) return invalid(`missing value for ${flag}`);
      seen.add(flag);
      index += 1;
      if (flag === "--provider") providerId = value;
      else if (flag === "--model") modelId = value;
      else thinking = value;
      continue;
    }
    return invalid(`unknown init option ${flag ?? ""}`);
  }
  if (minimal && (providerId !== undefined || modelId !== undefined || thinking !== undefined)) {
    return invalid("--minimal cannot be combined with provider, model, or thinking setup");
  }
  const command = {
    _tag: "Init",
    target,
    minimal,
    nonInteractive,
    ...Object.fromEntries(
      [
        providerId !== undefined ? (["providerId", providerId] as const) : undefined,
        modelId !== undefined ? (["modelId", modelId] as const) : undefined,
        thinking !== undefined ? (["thinking", thinking] as const) : undefined,
      ].flatMap((entry) => (entry === undefined ? [] : [entry])),
    ),
  } satisfies Extract<CliCommand, { _tag: "Init" }>;
  return command;
};

interface ParsedJsonArguments {
  readonly positional: ReadonlyArray<string>;
  readonly json: boolean;
}

const parseJsonArguments = (
  args: ReadonlyArray<string>,
  command: string,
): ParsedJsonArguments | CliInputInvalid => {
  const positional: Array<string> = [];
  let json = false;
  let endOfOptions = false;
  for (const argument of args) {
    if (!endOfOptions && argument === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && argument === "--json") {
      if (json) return invalid(`duplicate ${command} option --json`);
      json = true;
      continue;
    }
    positional.push(argument);
  }
  return { positional, json };
};

const isCliInputInvalid = (
  value: ParsedJsonArguments | CliInputInvalid,
): value is CliInputInvalid => Predicate.isTagged(value, "CliInputInvalid");

const parseRun = (args: ReadonlyArray<string>): CliCommand | CliInputInvalid => {
  const positional: Array<string> = [];
  let continueSession = false;
  let sessionId: string | undefined;
  let json = false;
  let endOfOptions = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!endOfOptions && argument === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (argument === "-c" || argument === "--continue")) {
      if (continueSession) return invalid(`duplicate run option ${argument}`);
      continueSession = true;
      continue;
    }
    if (!endOfOptions && argument === "--json") {
      if (json) return invalid("duplicate run option --json");
      json = true;
      continue;
    }
    if (!endOfOptions && argument === "--session") {
      if (sessionId !== undefined) return invalid("duplicate run option --session");
      const value = args[index + 1];
      if (!required(value) || value.startsWith("-")) {
        return invalid("missing value for --session");
      }
      sessionId = value;
      index += 1;
      continue;
    }
    positional.push(argument);
  }

  if (continueSession && sessionId !== undefined) {
    return invalid("--continue cannot be combined with --session");
  }

  const target = positional[0];
  const promptParts = positional.slice(1);
  if (!required(target) || promptParts.length === 0 || promptParts.join(" ").trim().length === 0) {
    return invalid(
      "usage: ziggy run [-c|--continue] [--json] [--session <id>] <name|path> <prompt...>",
    );
  }
  const command = {
    _tag: "Run",
    target,
    prompt: promptParts.join(" "),
    continueSession,
    json,
  } satisfies Extract<CliCommand, { _tag: "Run" }>;
  return sessionId === undefined ? command : { ...command, sessionId };
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

  if (word === "update") {
    if (rest.length !== 0) return invalid("usage: ziggy update");
    return { _tag: "Update" };
  }

  if (word === "tui") {
    if (rest.length > 1) return invalid("usage: ziggy tui [<name|path>]");
    return { _tag: "Tui", target: rest[0] ?? "." };
  }

  if (word === "init") return parseInit(rest);

  if (word === "acp") {
    const positional: Array<string> = [];
    let shared = false;
    let agent: string | undefined;
    for (const argument of rest) {
      if (argument === "--shared") {
        if (shared) return invalid("duplicate acp option --shared");
        shared = true;
      } else if (argument === "--agent") {
        if (agent !== undefined) return invalid("duplicate acp option --agent");
        agent = "";
      } else if (agent === "") {
        agent = argument;
      } else {
        positional.push(argument);
      }
    }
    if (positional.length !== 1 || !required(positional[0])) {
      return invalid("usage: ziggy acp <name|path> [--shared] [--agent <agent-id>]");
    }
    if (agent === "" || (agent !== undefined && !required(agent))) {
      return invalid("usage: ziggy acp <name|path> [--shared] [--agent <agent-id>]");
    }
    return { _tag: "Acp", target: positional[0], shared, agent };
  }

  if (word === "profiles") {
    const parsed = parseJsonArguments(rest, "profiles");
    if (isCliInputInvalid(parsed)) return parsed;
    if (parsed.positional.length !== 0) return invalid("usage: ziggy profiles [--json]");
    return { _tag: "Profiles", json: parsed.json };
  }

  if (word === "skills") {
    return invalid(
      "skills are part of extensions; use:\n  ziggy extensions list\n  ziggy extensions show <id>\n  ziggy extensions add <name|path> <id>\n  ziggy extensions remove <name|path> <id>",
    );
  }

  if (word === "extensions") {
    if (rest[0] === "list") {
      const parsed = parseJsonArguments(rest.slice(1), "extensions list");
      if (isCliInputInvalid(parsed)) return parsed;
      if (parsed.positional.length === 0) {
        return { _tag: "ExtensionsList", json: parsed.json };
      }
    }
    if (rest[0] === "show") {
      const parsed = parseJsonArguments(rest.slice(1), "extensions show");
      if (isCliInputInvalid(parsed)) return parsed;
      if (parsed.positional.length === 1 && required(parsed.positional[0])) {
        return { _tag: "ExtensionsShow", id: parsed.positional[0], json: parsed.json };
      }
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
    if (rest[0] === "list") {
      const parsed = parseJsonArguments(rest.slice(1), "agents list");
      if (isCliInputInvalid(parsed)) return parsed;
      if (parsed.positional.length === 1 && required(parsed.positional[0])) {
        return { _tag: "AgentsList", target: parsed.positional[0], json: parsed.json };
      }
    }
    if (rest[0] === "show") {
      const parsed = parseJsonArguments(rest.slice(1), "agents show");
      if (isCliInputInvalid(parsed)) return parsed;
      if (
        parsed.positional.length === 2 &&
        required(parsed.positional[0]) &&
        required(parsed.positional[1])
      ) {
        return {
          _tag: "AgentsShow",
          target: parsed.positional[0],
          agentId: parsed.positional[1],
          json: parsed.json,
        };
      }
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

  if (word === "doctor") {
    if (rest.length !== 1 || !required(rest[0])) return invalid("usage: ziggy doctor <name|path>");
    return { _tag: "Doctor", target: rest[0] };
  }

  if (word === "run") {
    return parseRun(rest);
  }

  if (word === "automations") {
    if (rest[0] === "create" && rest.length === 3 && required(rest[1]) && required(rest[2])) {
      return { _tag: "AutomationsCreate", target: rest[1], automationId: rest[2] };
    }
    if (rest[0] === "list") {
      const parsed = parseJsonArguments(rest.slice(1), "automations list");
      if (isCliInputInvalid(parsed)) return parsed;
      if (parsed.positional.length === 1 && required(parsed.positional[0])) {
        return { _tag: "AutomationsList", target: parsed.positional[0], json: parsed.json };
      }
    }
    if (
      (rest[0] === "pause" || rest[0] === "resume") &&
      rest.length === 3 &&
      required(rest[1]) &&
      required(rest[2])
    ) {
      return {
        _tag: rest[0] === "pause" ? "AutomationsPause" : "AutomationsResume",
        target: rest[1],
        automationId: rest[2],
      };
    }
    if (rest[0] === "validate" && (rest.length === 2 || rest.length === 3) && required(rest[1])) {
      const automationId = rest[2];
      return automationId === undefined
        ? { _tag: "AutomationsValidate", target: rest[1] }
        : { _tag: "AutomationsValidate", target: rest[1], automationId };
    }
    if (rest[0] === "status") {
      const parsed = parseJsonArguments(rest.slice(1), "automations status");
      if (isCliInputInvalid(parsed)) return parsed;
      if (parsed.positional.length === 1 && required(parsed.positional[0])) {
        return { _tag: "AutomationsStatus", target: parsed.positional[0], json: parsed.json };
      }
    }
    if (rest[0] === "runs") {
      const parsed = parseJsonArguments(rest.slice(1), "automations runs");
      if (isCliInputInvalid(parsed)) return parsed;
      if (
        (parsed.positional.length === 1 || parsed.positional.length === 2) &&
        required(parsed.positional[0])
      ) {
        const target = parsed.positional[0];
        const automationId = parsed.positional[1];
        return automationId === undefined
          ? { _tag: "AutomationsRuns", target, json: parsed.json }
          : { _tag: "AutomationsRuns", target, automationId, json: parsed.json };
      }
    }
    return invalid(
      "usage:\n  ziggy automations create <name|path> <automation-id>\n  ziggy automations list <name|path>\n  ziggy automations pause <name|path> <automation-id>\n  ziggy automations resume <name|path> <automation-id>\n  ziggy automations validate <name|path> [automation-id]\n  ziggy automations status <name|path>\n  ziggy automations runs <name|path> [automation-id]",
    );
  }

  if (word === "wake") {
    if (rest.length !== 2 || !required(rest[0]) || !required(rest[1])) {
      return invalid("usage: ziggy wake <name|path> <automation-id>");
    }
    return { _tag: "Wake", target: rest[0], automationId: rest[1] };
  }

  if (word === "sessions") {
    if (rest[0] === "list") {
      const parsed = parseJsonArguments(rest.slice(1), "sessions list");
      if (isCliInputInvalid(parsed)) return parsed;
      if (parsed.positional.length === 1 && required(parsed.positional[0])) {
        return { _tag: "SessionsList", target: parsed.positional[0], json: parsed.json };
      }
    }
    if (rest[0] === "show") {
      const parsed = parseJsonArguments(rest.slice(1), "sessions show");
      if (isCliInputInvalid(parsed)) return parsed;
      if (
        parsed.positional.length === 2 &&
        required(parsed.positional[0]) &&
        required(parsed.positional[1])
      ) {
        return {
          _tag: "SessionsShow",
          target: parsed.positional[0],
          reference: parsed.positional[1],
          json: parsed.json,
        };
      }
    }
    return invalid(
      "usage:\n  ziggy sessions list <name|path>\n  ziggy sessions show <name|path> <session-id|relative-path>",
    );
  }

  if (word === "memory") {
    if (rest[0] === "list") {
      const parsed = parseJsonArguments(rest.slice(1), "memory list");
      if (isCliInputInvalid(parsed)) return parsed;
      if (parsed.positional.length <= 1) {
        const target = parsed.positional[0];
        return target === undefined
          ? { _tag: "MemoryList", json: parsed.json }
          : { _tag: "MemoryList", target, json: parsed.json };
      }
    }
    if (rest[0] === "show") {
      const parsed = parseJsonArguments(rest.slice(1), "memory show");
      if (isCliInputInvalid(parsed)) return parsed;
      if (
        parsed.positional.length === 2 &&
        required(parsed.positional[0]) &&
        required(parsed.positional[1])
      ) {
        return {
          _tag: "MemoryShow",
          target: parsed.positional[0],
          scope: parsed.positional[1],
          json: parsed.json,
        };
      }
    }
    return invalid(
      "usage:\n  ziggy memory list [<name|path>] [--json]\n  ziggy memory show <name|path> <shared|user:<id>|group:<id>> [--json]",
    );
  }

  if (word === "serve") {
    if (rest[0] === "install" && required(rest[1])) {
      let force = false;
      let noStart = false;
      for (const option of rest.slice(2)) {
        if (option === "--force" && !force) force = true;
        else if (option === "--no-start" && !noStart) noStart = true;
        else return invalid(`unknown or duplicate serve install option ${option}`);
      }
      return { _tag: "ServeInstall", target: rest[1], force, noStart };
    }
    if (
      (rest[0] === "start" ||
        rest[0] === "stop" ||
        rest[0] === "restart" ||
        rest[0] === "status" ||
        rest[0] === "uninstall") &&
      rest.length === 2 &&
      required(rest[1])
    ) {
      const tags = {
        start: "ServeStart",
        stop: "ServeStop",
        restart: "ServeRestart",
        status: "ServeStatus",
        uninstall: "ServeUninstall",
      } as const;
      return { _tag: tags[rest[0]], target: rest[1] };
    }
    if (
      rest[0] === "logs" &&
      required(rest[1]) &&
      (rest.length === 2 || (rest.length === 3 && rest[2] === "--follow"))
    ) {
      return { _tag: "ServeLogs", target: rest[1], follow: rest.length === 3 };
    }
    if (rest.length === 1 && required(rest[0])) return { _tag: "Serve", target: rest[0] };
    return invalid(serveHelp);
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

export const decodeCliCommand = (
  input: ReadonlyArray<string>,
): Effect.Effect<CliCommand, CliInputInvalid> => {
  const parsed = parseTypedArguments(input);
  if (parsed._tag === "CliInputInvalid") return Effect.fail(parsed);
  if (parsed._tag !== "MemoryShow") return Effect.succeed(parsed);
  return decodeMemoryScope(parsed.scope).pipe(
    Effect.map((scope) => ({ ...parsed, scope })),
    Effect.mapError(() =>
      invalid("usage: ziggy memory show <name|path> <shared|user:<id>|group:<id>> [--json]"),
    ),
  );
};

const generalHelp = `Usage:
  ziggy [<name|path>]
  ziggy tui [<name|path>]
  ziggy run [-c|--continue] [--json] [--session <id>] <name|path> <prompt...>
  ziggy acp <name|path> [--shared] [--agent <agent-id>]
  ziggy init <name|path> [--minimal] [--provider <id>] [--model <id>] [--thinking <level>] [--non-interactive]
  ziggy profiles [--json]
  ziggy auth <name|path> [provider] [--type api_key|oauth]
  ziggy models status <name|path>
  ziggy models list <name|path> [--provider <id>]
  ziggy models set <name|path> <provider>/<model> [--thinking <level>]
  ziggy agents create|list|show|validate|run ... [--json on list/show]
  ziggy doctor <name|path>
  ziggy extensions list|show|add|remove ... [--json on list/show]
  ziggy automations create|list|pause|resume|validate|status|runs ... [--json on list/status/runs]
  ziggy wake <name|path> <automation-id>
  ziggy sessions list|show ... [--json]
  ziggy memory list|show ... [--json]
  ziggy serve <name|path>
  ziggy serve install <name|path> [--force] [--no-start]
  ziggy serve start|stop|restart <name|path>
  ziggy serve status <name|path>
  ziggy serve logs <name|path> [--follow]
  ziggy serve uninstall <name|path>
  ziggy gateway <name|path>  # compatibility alias
  ziggy help [command]
  ziggy version
  ziggy update`;

const topicHelp = {
  help: "usage: ziggy help [command]",
  version: "usage: ziggy version",
  update: "usage: ziggy update",
  init: "usage: ziggy init <name|path> [--minimal] [--provider <id>] [--model <id>] [--thinking <level>] [--non-interactive]",
  profiles: "usage: ziggy profiles [--json]",
  extensions:
    "usage:\n  ziggy extensions list [--json]\n  ziggy extensions show <id> [--json]\n  ziggy extensions add <name|path> <id>\n  ziggy extensions remove <name|path> <id>",
  auth: "usage: ziggy auth <name|path> [provider] [--type api_key|oauth]",
  models:
    "usage:\n  ziggy models status <name|path>\n  ziggy models list <name|path> [--provider <id>]\n  ziggy models set <name|path> <provider>/<model> [--thinking <level>]",
  agents:
    "usage:\n  ziggy agents create <name|path> <agent-id>\n  ziggy agents list <name|path> [--json]\n  ziggy agents show <name|path> <agent-id> [--json]\n  ziggy agents validate <name|path> [agent-id]\n  ziggy agents run <name|path> <agent-id> <prompt...>",
  doctor: "usage: ziggy doctor <name|path>",
  run: "usage: ziggy run [-c|--continue] [--json] [--session <id>] <name|path> <prompt...> (JSON mode emits Pi event lines)",
  acp: "usage: ziggy acp <name|path> [--shared] [--agent <agent-id>]",
  automations:
    "usage:\n  ziggy automations create <name|path> <automation-id>\n  ziggy automations list <name|path> [--json]\n  ziggy automations pause <name|path> <automation-id>\n  ziggy automations resume <name|path> <automation-id>\n  ziggy automations validate <name|path> [automation-id]\n  ziggy automations status <name|path> [--json]\n  ziggy automations runs <name|path> [automation-id] [--json]",
  wake: "usage: ziggy wake <name|path> <automation-id>",
  sessions:
    "usage:\n  ziggy sessions list <name|path> [--json]\n  ziggy sessions show <name|path> <session-id|relative-path> [--json]",
  memory:
    "usage:\n  ziggy memory list [<name|path>] [--json]\n  ziggy memory show <name|path> <shared|user:<id>|group:<id>> [--json]",
  serve: serveHelp,
  gateway: "usage: ziggy gateway <name|path> (compatibility alias for serve)",
  tui: "usage: ziggy tui [<name|path>]",
} satisfies Record<HelpTopic, string>;

export const renderHelp = (topic?: HelpTopic): string =>
  topic === undefined ? generalHelp : topicHelp[topic];

export const isForegroundResidentArguments = (args: ReadonlyArray<string>): boolean =>
  args.length === 2 && (args[0] === "serve" || args[0] === "gateway");
