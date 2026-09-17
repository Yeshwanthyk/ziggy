import type { HelpTopic } from "./cli";

export const ziggyHelpTopics = [
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
  "web",
  "gateway",
  "tui",
] as const satisfies ReadonlyArray<HelpTopic>;

export const isZiggyHelpTopic = (value: string): value is HelpTopic =>
  ziggyHelpTopics.some((topic) => topic === value);

const serveHelp = `usage:
  ziggy serve <name|path>
  ziggy serve install <name|path> [--force] [--no-start]
  ziggy serve start <name|path>
  ziggy serve stop <name|path>
  ziggy serve restart <name|path>
  ziggy serve status <name|path>
  ziggy serve logs <name|path> [--follow]
  ziggy serve uninstall <name|path>`;

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
  ziggy extensions manage|list|show|add|remove|update ... [--json on list/show]
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
  ziggy web configure <name|path> --port <port> [--public-url <url>]
  ziggy web pair <name|path>
  ziggy web revoke <name|path>
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
    "usage:\n  ziggy extensions [manage [<name|path>]]\n  ziggy extensions list [--json]\n  ziggy extensions show <id> [--json]\n  ziggy extensions add <name|path> <id>\n  ziggy extensions remove <name|path> <id>\n  ziggy extensions update <name|path> <id> [--adopt]",
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
  web: "usage:\n  ziggy web configure <name|path> --port <port> [--public-url <url>]\n  ziggy web pair <name|path>\n  ziggy web revoke <name|path>",
  gateway: "usage: ziggy gateway <name|path> (compatibility alias for serve)",
  tui: "usage: ziggy tui [<name|path>]",
} satisfies Record<HelpTopic, string>;

export const renderZiggyHelp = (topic?: HelpTopic): string =>
  topic === undefined ? generalHelp : topicHelp[topic];
