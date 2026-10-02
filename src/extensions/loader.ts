import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createAgentSessionServices,
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Effect, Predicate } from "effect";
import type { ProfileExtensionInvalid } from "../domain/profile";
import type { ProfileFileSystemError } from "../profile";
import { mcpExtensions, type ProfileMcpOptions } from "./mcp";
import { resolveResources, type PiResources } from "./resources";
import {
  ExtensionLoadFailed,
  type ExtensionCheck,
  type ExtensionDiagnostic,
  type SkippedPackage,
} from "./types";

const MAX_DIAGNOSTICS = 12;

const MAX_SOURCE = 160;

const MAX_MESSAGE = 360;

const bounded = (value: string, maximum: number): string =>
  [...value.replace(/\s+/gu, " ").trim()].slice(0, maximum).join("");

const boundedDiagnostic = (diagnostic: ExtensionDiagnostic): ExtensionDiagnostic => ({
  source: bounded(diagnostic.source, MAX_SOURCE),
  message: bounded(diagnostic.message, MAX_MESSAGE),
});

type LoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

/** The one resource-loader shape every Ziggy session, specialist and check uses. */
export const loaderOptions = (
  systemPrompt: string,
  resources: PiResources,
  inline: ReadonlyArray<InlineExtension>,
): LoaderOptions => {
  const options: LoaderOptions = {
    systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [...inline],
  };

  if (resources.extensionPaths.length > 0) {
    options.additionalExtensionPaths = [...resources.extensionPaths];
  }

  if (resources.skillPaths.length > 0) options.additionalSkillPaths = [...resources.skillPaths];

  return options;
};

const extensionDiagnostics = (
  services: AgentSessionServices,
): ReadonlyArray<ExtensionDiagnostic> => {
  const extensions = services.resourceLoader.getExtensions();
  const owners = new Map<string, string>();
  const conflicts: ExtensionDiagnostic[] = [];

  for (const extension of extensions.extensions) {
    for (const name of extension.commands.keys()) {
      const owner = owners.get(name);

      if (owner !== undefined && owner !== extension.path) {
        conflicts.push({
          source: extension.path,
          message: `Command "${name}" conflicts with ${owner}`,
        });
      } else {
        owners.set(name, extension.path);
      }
    }
  }

  return [
    ...extensions.errors.map((item) => ({ source: item.path, message: item.error })),
    ...conflicts,
  ];
};

const collectDiagnostics = (services: AgentSessionServices): ReadonlyArray<ExtensionDiagnostic> => [
  ...extensionDiagnostics(services),
  ...services.resourceLoader
    .getSkills()
    .diagnostics.map((item) => ({ source: item.path ?? "skills", message: item.message })),
  ...services.diagnostics
    .filter((item) => item.type === "error")
    .map((item) => ({ source: "services", message: `${item.type}: ${item.message}` })),
];

const stageFor = (services: AgentSessionServices): ExtensionLoadFailed["stage"] => {
  if (extensionDiagnostics(services).length > 0) return "extensions";

  if (services.resourceLoader.getSkills().diagnostics.length > 0) return "skills";

  return "services";
};

const loadFailure = (
  profilePath: string,
  stage: ExtensionLoadFailed["stage"],
  diagnostics: ReadonlyArray<ExtensionDiagnostic>,
): ExtensionLoadFailed => {
  const shown = diagnostics.slice(0, MAX_DIAGNOSTICS).map(boundedDiagnostic);

  return new ExtensionLoadFailed({
    profilePath,
    stage,
    message: `Pi resource loading found ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`,
    diagnostics: shown,
    cause: { diagnosticCount: diagnostics.length, diagnostics: shown },
  });
};

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`);

interface Partition {
  readonly resources: PiResources;
  readonly skipped: ReadonlyArray<SkippedPackage>;
  readonly fatal: ReadonlyArray<ExtensionDiagnostic>;
}

/**
 * Pin each diagnostic on the optional package whose folder it came from, and drop those
 * packages. A command conflict names both owners; the earlier one is blamed when the later
 * one is not optional. Anything that no optional package owns is fatal.
 */
const partition = (
  resources: PiResources,
  diagnostics: ReadonlyArray<ExtensionDiagnostic>,
): Partition => {
  const roots = resources.optional
    .map((item) => ({ id: item.id, root: canonicalPath(item.packagePath) }))
    .sort((left, right) => right.root.length - left.root.length);

  const ownerOf = (source: string) => {
    const path = canonicalPath(source);

    return roots.find((item) => within(item.root, path));
  };

  const byPackage = new Map<string, ExtensionDiagnostic[]>();
  const fatal: ExtensionDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const conflict = /Command "[^"]+" conflicts with (.+)$/u.exec(diagnostic.message)?.[1];
    const current = ownerOf(diagnostic.source);
    const previous = conflict === undefined ? undefined : ownerOf(conflict);
    const owner = current ?? previous;

    if (owner === undefined) {
      fatal.push(diagnostic);
      continue;
    }

    const entries = byPackage.get(owner.id) ?? [];
    entries.push(
      current === undefined && conflict !== undefined
        ? { source: conflict, message: diagnostic.message }
        : diagnostic,
    );
    byPackage.set(owner.id, entries);
  }

  const skipped = [...byPackage].map(([id, entries]) => ({
    id,
    diagnostics: entries.slice(0, MAX_DIAGNOSTICS).map(boundedDiagnostic),
  }));

  const rejected = roots.filter((item) => byPackage.has(item.id)).map((item) => item.root);

  const retained = (source: string) =>
    !rejected.some((root) => within(root, canonicalPath(source)));

  return {
    resources: {
      extensionPaths: resources.extensionPaths.filter(retained),
      skillPaths: resources.skillPaths.filter(retained),
      optional: resources.optional.filter((item) => !byPackage.has(item.id)),
      plugins: resources.plugins.filter((item) => !byPackage.has(item.id)),
    },
    skipped,
    fatal,
  };
};

export interface LoadedServices {
  readonly services: AgentSessionServices;
  /** The resources Pi loaded after dropping skipped packages. */
  readonly resources: PiResources;
  readonly skipped: ReadonlyArray<SkippedPackage>;
}

export interface LoadRequest {
  readonly profilePath: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly systemPrompt: string;
  readonly resources: PiResources;
  readonly inline: ReadonlyArray<InlineExtension>;
  /** Load Pi's MCP stack with these servers; a session without it can never gain MCP tools. */
  readonly mcp?: ProfileMcpOptions | undefined;
  /** Refuse, rather than skip, these optional packages when Pi cannot load them. */
  readonly rejectIds?: ReadonlyArray<string>;
}

/**
 * Build Pi services for `resources`. Optional packages Pi cannot load are skipped and the
 * services rebuilt once without them; anything else Pi reports fails with
 * `ExtensionLoadFailed`. Pi calls this from its runtime factory, so it is a Promise.
 */
export const loadServices = async (request: LoadRequest): Promise<LoadedServices> => {
  // Rebuilt per resource set, so a plugin Pi skipped never contributes MCP servers.
  const inline = (resources: PiResources) =>
    request.mcp === undefined
      ? request.inline
      : [
          ...request.inline,
          ...mcpExtensions(
            request.profilePath,
            request.mcp,
            resources.plugins.map((plugin) => plugin.id),
          ),
        ];

  const build = (resources: PiResources) =>
    createAgentSessionServices({
      cwd: request.cwd,
      agentDir: request.agentDir,
      resourceLoaderOptions: loaderOptions(request.systemPrompt, resources, inline(resources)),
    });

  const services = await build(request.resources);
  const split = partition(request.resources, collectDiagnostics(services));

  if (split.fatal.length > 0)
    throw loadFailure(request.profilePath, stageFor(services), split.fatal);

  const refused = split.skipped.filter((item) => request.rejectIds?.includes(item.id) === true);

  if (refused.length > 0) {
    throw loadFailure(
      request.profilePath,
      stageFor(services),
      refused.flatMap((item) => item.diagnostics),
    );
  }

  if (split.skipped.length === 0) {
    return { services, resources: request.resources, skipped: [] };
  }

  // Pi services have no dispose; invalidate the discarded loader's extension runtime to
  // release its event-bus subscriptions before building the healthy set.
  services.resourceLoader.getExtensions().runtime.invalidate();
  const healthy = await build(split.resources);
  const remaining = collectDiagnostics(healthy);

  if (remaining.length > 0) throw loadFailure(request.profilePath, stageFor(healthy), remaining);

  return { services: healthy, resources: split.resources, skipped: split.skipped };
};

const isLoadFailed = (cause: unknown): cause is ExtensionLoadFailed =>
  Predicate.isTagged(cause, "ExtensionLoadFailed");

const servicesFailure = (profilePath: string, message: string, cause: unknown) =>
  new ExtensionLoadFailed({
    profilePath,
    stage: "services",
    message,
    diagnostics: [{ source: "services", message }],
    cause,
  });

/**
 * Load `selected` through Pi in throwaway storage and report what it would skip. This runs
 * only the packages, not Ziggy's own inline extensions, so a check never touches sessions.
 */
export const checkSelection = (
  profilePath: string,
  selected: ReadonlyArray<string>,
  rejectIds: ReadonlyArray<string> = [],
): Effect.Effect<
  ExtensionCheck,
  ProfileExtensionInvalid | ProfileFileSystemError | ExtensionLoadFailed
> =>
  Effect.gen(function* () {
    const resources = yield* resolveResources(profilePath, selected);

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "ziggy-extension-check-")),
        catch: (cause) => servicesFailure(profilePath, "could not create Pi check storage", cause),
      }),
      (agentDir) =>
        Effect.tryPromise({
          try: () =>
            loadServices({
              profilePath,
              cwd: profilePath,
              agentDir,
              systemPrompt: "",
              resources,
              inline: [],
              rejectIds,
            }),
          catch: (cause) =>
            isLoadFailed(cause)
              ? cause
              : servicesFailure(profilePath, "could not construct Pi resource services", cause),
        }).pipe(
          Effect.map((loaded) => ({
            extensionPathCount: loaded.resources.extensionPaths.length,
            skillPathCount: loaded.resources.skillPaths.length,
            extensionFactoryCount: 0,
            skipped: loaded.skipped,
          })),
        ),
      (agentDir) =>
        Effect.tryPromise({
          try: () => rm(agentDir, { recursive: true, force: true }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not remove Pi check storage", { agentDir, cause }),
          ),
        ),
    );
  });
