import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import {
  ProfileExtensionPreflightFailed,
  type ProfileExtensionPreflightFailed as ProfileExtensionPreflightFailedType,
} from "../../domain/profile-extension";

export const MAX_PI_RESOURCE_DIAGNOSTICS = 12;
export const MAX_PI_DIAGNOSTIC_SOURCE = 160;
export const MAX_PI_DIAGNOSTIC_MESSAGE = 360;

const bounded = (value: string, maximum: number): string =>
  [...value.replace(/\s+/gu, " ").trim()].slice(0, maximum).join("");

export interface PiResourceDiagnostic {
  readonly source: string;
  readonly message: string;
}

const commandConflictDiagnostics = (
  extensions: ReturnType<AgentSessionServices["resourceLoader"]["getExtensions"]>["extensions"],
): ReadonlyArray<PiResourceDiagnostic> => {
  const owners = new Map<string, string>();
  const diagnostics: PiResourceDiagnostic[] = [];
  for (const extension of extensions) {
    for (const name of extension.commands.keys()) {
      const owner = owners.get(name);
      if (owner !== undefined && owner !== extension.path) {
        diagnostics.push({
          source: extension.path,
          message: `Command "${name}" conflicts with ${owner}`,
        });
      } else {
        owners.set(name, extension.path);
      }
    }
  }
  return diagnostics;
};

const extensionDiagnostics = (
  services: AgentSessionServices,
): ReadonlyArray<PiResourceDiagnostic> => {
  const extensions = services.resourceLoader.getExtensions();
  return [
    ...extensions.errors.map((diagnostic) => ({
      source: diagnostic.path,
      message: diagnostic.error,
    })),
    ...commandConflictDiagnostics(extensions.extensions),
  ];
};

export const collectPiResourceDiagnostics = (
  services: AgentSessionServices,
): ReadonlyArray<PiResourceDiagnostic> => {
  const extensions = extensionDiagnostics(services);
  const skills = services.resourceLoader.getSkills();
  return [
    ...extensions,
    ...skills.diagnostics.map((diagnostic) => ({
      source: diagnostic.path ?? "skills",
      message: diagnostic.message,
    })),
    ...services.diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => ({
        source: "services",
        message: `${diagnostic.type}: ${diagnostic.message}`,
      })),
  ];
};

const stageFor = (services: AgentSessionServices): ProfileExtensionPreflightFailedType["stage"] => {
  if (extensionDiagnostics(services).length > 0) return "extensions";
  if (services.resourceLoader.getSkills().diagnostics.length > 0) return "skills";
  return "services";
};

export const piResourceDiagnosticFailure = (
  profilePath: string,
  services: AgentSessionServices,
  diagnostics: ReadonlyArray<PiResourceDiagnostic> = collectPiResourceDiagnostics(services),
): ProfileExtensionPreflightFailed | undefined => {
  if (diagnostics.length === 0) return undefined;
  const boundedDiagnostics = diagnostics
    .slice(0, MAX_PI_RESOURCE_DIAGNOSTICS)
    .map((diagnostic) => ({
      source: bounded(diagnostic.source, MAX_PI_DIAGNOSTIC_SOURCE),
      message: bounded(diagnostic.message, MAX_PI_DIAGNOSTIC_MESSAGE),
    }));
  return new ProfileExtensionPreflightFailed({
    profilePath,
    stage: stageFor(services),
    message: bounded(
      `Pi resource loading found ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`,
      MAX_PI_DIAGNOSTIC_MESSAGE,
    ),
    diagnostics: boundedDiagnostics,
    cause: {
      diagnosticCount: diagnostics.length,
      diagnostics: boundedDiagnostics,
    },
  });
};

/** Assert the same resource-loader contract immediately after production service creation. */
export const assertNoPiResourceDiagnostics = (
  profilePath: string,
  services: AgentSessionServices,
): void => {
  const failure = piResourceDiagnosticFailure(profilePath, services);
  if (failure !== undefined) throw failure;
};
