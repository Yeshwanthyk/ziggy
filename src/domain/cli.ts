import { Schema } from "effect";

export type HelpTopic =
  | "help"
  | "version"
  | "init"
  | "profiles"
  | "skills"
  | "extensions"
  | "auth"
  | "models"
  | "agents"
  | "doctor"
  | "run"
  | "automations"
  | "wake"
  | "sessions"
  | "serve"
  | "gateway"
  | "tui";

export type CliCommand =
  | { readonly _tag: "Help"; readonly topic?: HelpTopic }
  | { readonly _tag: "Version" }
  | {
      readonly _tag: "Init";
      readonly target: string;
      readonly minimal: boolean;
      readonly nonInteractive: boolean;
      readonly providerId?: string;
      readonly modelId?: string;
      readonly thinking?: string;
    }
  | { readonly _tag: "Profiles" }
  | { readonly _tag: "SkillsList"; readonly target: string }
  | {
      readonly _tag: "SkillsAdd";
      readonly target: string;
      readonly source: string;
      readonly force: boolean;
    }
  | { readonly _tag: "ExtensionsList" }
  | { readonly _tag: "ExtensionsShow"; readonly id: string }
  | { readonly _tag: "ExtensionsAdd"; readonly target: string; readonly id: string }
  | { readonly _tag: "ExtensionsRemove"; readonly target: string; readonly id: string }
  | { readonly _tag: "AuthStatus"; readonly target: string }
  | {
      readonly _tag: "AuthLogin";
      readonly target: string;
      readonly providerId: string;
      readonly type?: "api_key" | "oauth";
    }
  | { readonly _tag: "ModelsStatus"; readonly target: string }
  | { readonly _tag: "Doctor"; readonly target: string }
  | { readonly _tag: "ModelsList"; readonly target: string; readonly providerId?: string }
  | {
      readonly _tag: "ModelsSet";
      readonly target: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly thinking?: string;
    }
  | { readonly _tag: "AgentsCreate"; readonly target: string; readonly agentId: string }
  | { readonly _tag: "AgentsList"; readonly target: string }
  | { readonly _tag: "AgentsShow"; readonly target: string; readonly agentId: string }
  | { readonly _tag: "AgentsValidate"; readonly target: string; readonly agentId?: string }
  | {
      readonly _tag: "AgentsRun";
      readonly target: string;
      readonly agentId: string;
      readonly prompt: string;
    }
  | {
      readonly _tag: "Run";
      readonly target: string;
      readonly prompt: string;
      readonly continueSession: boolean;
    }
  | {
      readonly _tag: "AutomationsCreate";
      readonly target: string;
      readonly automationId: string;
    }
  | { readonly _tag: "AutomationsList"; readonly target: string }
  | { readonly _tag: "AutomationsPause"; readonly target: string; readonly automationId: string }
  | { readonly _tag: "AutomationsResume"; readonly target: string; readonly automationId: string }
  | {
      readonly _tag: "AutomationsValidate";
      readonly target: string;
      readonly automationId?: string;
    }
  | { readonly _tag: "AutomationsStatus"; readonly target: string }
  | { readonly _tag: "AutomationsRuns"; readonly target: string; readonly automationId?: string }
  | { readonly _tag: "Wake"; readonly target: string; readonly automationId: string }
  | { readonly _tag: "SessionsList"; readonly target: string }
  | { readonly _tag: "SessionsShow"; readonly target: string; readonly reference: string }
  | { readonly _tag: "Serve"; readonly target: string }
  | {
      readonly _tag: "ServeInstall";
      readonly target: string;
      readonly force: boolean;
      readonly noStart: boolean;
    }
  | { readonly _tag: "ServeStart"; readonly target: string }
  | { readonly _tag: "ServeStop"; readonly target: string }
  | { readonly _tag: "ServeRestart"; readonly target: string }
  | { readonly _tag: "ServeStatus"; readonly target: string }
  | { readonly _tag: "ServeLogs"; readonly target: string; readonly follow: boolean }
  | { readonly _tag: "ServeUninstall"; readonly target: string }
  | { readonly _tag: "Gateway"; readonly target: string }
  | { readonly _tag: "UnsupportedResidentAlias"; readonly name: "discord" | "slack" }
  | { readonly _tag: "Tui"; readonly target: string };

export class CliInputInvalid extends Schema.TaggedErrorClass<CliInputInvalid>()("CliInputInvalid", {
  message: Schema.String,
}) {}
