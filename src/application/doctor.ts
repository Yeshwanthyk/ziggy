import { lstat, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import { fileSystemCauseDetails } from "../adapters/fs/cause";
import { discoverProfileAgents } from "../adapters/fs/profile-agents";
import {
  gatewayConfigPresent,
  loadDiscordConfigFile,
  loadSlackConfigFile,
  loadTelegramConfigFile,
} from "../adapters/fs/gateway-config";
import { describePinnedPiDocs, loadPinnedPiDocs } from "../adapters/pi/pi-docs";
import { discoverPiResources } from "../adapters/pi/resources";
import { listProfileSessions } from "../adapters/pi/sessions";
import { readSlackHealth } from "../adapters/fs/slack-health";
import { readDiscordHealth } from "../adapters/fs/discord-health";
import { type AuthApi, Auth } from "./auth";
import { type ModelsApi, Models } from "./models";
import { ExtensionCatalogService, type ExtensionCatalogApi } from "./extension-catalog";
import { parseAutomationFile } from "../domain/automation";
import { CONTEXT_MEMORY_CAP, SHARED_MEMORY_CAP, codePointLength } from "../domain/memory";
import { type DoctorCheck, type DoctorReport, doctorReport } from "../domain/doctor";
import type { ProfileTarget } from "../domain/profile";
import packageJson from "../../package.json" with { type: "json" };

export interface DoctorApi {
  readonly check: (
    target: ProfileTarget,
    repositoryRoot: string,
  ) => Effect.Effect<DoctorReport, never>;
}

export class Doctor extends Context.Service<Doctor, DoctorApi>()("ziggy/Doctor") {}

const ok = (id: string, message: string): DoctorCheck => ({ id, severity: "ok", message });
const warn = (id: string, message: string): DoctorCheck => ({ id, severity: "warn", message });
const error = (id: string, message: string): DoctorCheck => ({ id, severity: "error", message });

const inspect = (targetPath: string) =>
  Effect.tryPromise({
    try: () => lstat(targetPath),
    catch: (cause) => cause,
  });

const readDirectory = (directoryPath: string) =>
  Effect.tryPromise({
    try: () => readdir(directoryPath, { withFileTypes: true }),
    catch: (cause) => cause,
  });

const readText = (filePath: string) =>
  Effect.tryPromise({
    try: (signal) => readFile(filePath, { encoding: "utf8", signal }),
    catch: (cause) => cause,
  });

const isMissing = (cause: unknown): boolean => fileSystemCauseDetails(cause).code === "ENOENT";

const profileCheck = (target: ProfileTarget): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    const directory = yield* Effect.result(inspect(target.path));
    if (directory._tag === "Failure") {
      return error("profile", `Profile directory is not readable: ${target.path}`);
    }
    if (directory.success.isSymbolicLink() || !directory.success.isDirectory()) {
      return error("profile", `Profile path is not a regular directory: ${target.path}`);
    }
    const soulPath = path.join(target.path, "SOUL.md");
    const soul = yield* Effect.result(inspect(soulPath));
    if (soul._tag === "Failure")
      return error("profile", `SOUL.md is missing or unreadable: ${soulPath}`);
    return soul.success.isFile() && !soul.success.isSymbolicLink()
      ? ok("profile", "Profile directory and SOUL.md are readable")
      : error("profile", `SOUL.md must be a regular non-symlink file: ${soulPath}`);
  });

const modelCheck = (target: ProfileTarget, models: ModelsApi): Effect.Effect<DoctorCheck> =>
  models.readOnlyStatus(target).pipe(
    Effect.map((status) =>
      status.providerId === undefined || status.modelId === undefined
        ? error("model", "No effective Pi model is selected")
        : ok(
            "model",
            `Pi model settings resolve to ${status.providerId}/${status.modelId} (${status.thinking})`,
          ),
    ),
    Effect.catch(() =>
      Effect.succeed(error("model", "Pi model settings are invalid or unreadable")),
    ),
  );

const authCheck = (
  target: ProfileTarget,
  auth: AuthApi,
  models: ModelsApi,
): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    const status = yield* models.readOnlyStatus(target);
    if (status.providerId === undefined)
      return warn("auth", "Provider auth cannot be checked until a model is selected");
    const providers = yield* auth.readOnlyStatus(target);
    const provider = providers.find((candidate) => candidate.id === status.providerId);
    return provider?.configured === undefined
      ? error("auth", `Provider ${status.providerId} is not authenticated`)
      : ok("auth", `Provider ${status.providerId} authentication is configured`);
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(error("auth", "Provider authentication could not be checked")),
    ),
  );

const agentsCheck = (target: ProfileTarget, models: ModelsApi): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    const agents = yield* discoverProfileAgents(target.path);
    const known = agents.some((agent) => agent.provider !== undefined)
      ? yield* models.list(target)
      : [];
    for (const agent of agents) {
      if (agent.provider === undefined || agent.model === undefined) continue;
      const model = known.find(
        (candidate) => candidate.providerId === agent.provider && candidate.modelId === agent.model,
      );
      if (model === undefined)
        return error("agents", `Profile agent ${agent.id} selects an unknown Pi model`);
      if (agent.thinking !== undefined && !model.thinkingLevels.includes(agent.thinking)) {
        return error(
          "agents",
          `Profile agent ${agent.id} selects unsupported thinking ${agent.thinking}`,
        );
      }
    }
    return ok(
      "agents",
      `${agents.length} Profile agent file${agents.length === 1 ? "" : "s"} valid`,
    );
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(error("agents", "Profile agent files are invalid or unreadable")),
    ),
  );

const automationsCheck = (target: ProfileTarget): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    const directoryPath = path.join(target.path, "automations");
    const status = yield* Effect.result(inspect(directoryPath));
    if (status._tag === "Failure") {
      return isMissing(status.failure)
        ? ok("automations", "0 automation files valid")
        : error("automations", "Automation directory is unreadable");
    }
    if (status.success.isSymbolicLink() || !status.success.isDirectory()) {
      return error("automations", "Automation root must be a regular directory");
    }
    const entries = (yield* readDirectory(directoryPath))
      .filter((entry) => entry.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name));
    let manualOnly = 0;
    for (const entry of entries) {
      const filePath = path.join(directoryPath, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink())
        return error("automations", `Automation file is not regular: ${entry.name}`);
      const automation = yield* parseAutomationFile(
        path.basename(entry.name, ".md"),
        filePath,
        yield* readText(filePath),
      );
      if (automation.gate === undefined) manualOnly += 1;
    }
    return manualOnly > 0
      ? warn(
          "automations",
          `${entries.length} automation files valid; ${manualOnly} manual-only without a gate`,
        )
      : ok(
          "automations",
          `${entries.length} automation file${entries.length === 1 ? "" : "s"} valid`,
        );
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(error("automations", "Automation files are invalid or unreadable")),
    ),
  );

const collectMemoryFiles = (directoryPath: string): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.gen(function* () {
    const status = yield* Effect.result(inspect(directoryPath));
    if (status._tag === "Failure")
      return isMissing(status.failure) ? [] : yield* Effect.fail(status.failure);
    if (status.success.isSymbolicLink() || !status.success.isDirectory())
      return yield* Effect.fail("invalid memory directory");
    const files: string[] = [];
    for (const entry of (yield* readDirectory(directoryPath)).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) return yield* Effect.fail("symlinked memory entry");
      if (entry.isDirectory()) files.push(...(yield* collectMemoryFiles(entryPath)));
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
    }
    return files;
  });

const memoryCheck = (target: ProfileTarget): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    const sharedPath = path.join(target.path, "MEMORY.md");
    const files = [...(yield* collectMemoryFiles(path.join(target.path, "memory")))];
    const shared = yield* Effect.result(inspect(sharedPath));
    if (shared._tag === "Success") {
      if (!shared.success.isFile() || shared.success.isSymbolicLink())
        return error("memory", "MEMORY.md must be a regular non-symlink file");
      files.unshift(sharedPath);
    } else if (!isMissing(shared.failure)) return error("memory", "MEMORY.md is unreadable");
    for (const filePath of files) {
      const cap = filePath === sharedPath ? SHARED_MEMORY_CAP : CONTEXT_MEMORY_CAP;
      if (codePointLength(yield* readText(filePath)) > cap)
        return error("memory", `Memory size cap exceeded: ${path.relative(target.path, filePath)}`);
    }
    return ok(
      "memory",
      `${files.length} memory file${files.length === 1 ? "" : "s"} within size caps`,
    );
  }).pipe(
    Effect.catch(() => Effect.succeed(error("memory", "Memory files are invalid or unreadable"))),
  );

const resourcesCheck = (
  target: ProfileTarget,
  repositoryRoot: string,
  catalog: ExtensionCatalogApi | undefined,
): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    if (catalog !== undefined) {
      const materialized = yield* catalog
        .materialize(target.path, repositoryRoot)
        .pipe(Effect.result);
      if (materialized._tag === "Failure") {
        return error("resources", "Selected extensions or installed skills are invalid");
      }
    }
    return yield* discoverPiResources(target.path, repositoryRoot).pipe(
      Effect.map((resources) =>
        ok(
          "resources",
          `${resources.extensionFactories.length} bundled factories, ${resources.extensionPaths.length} Profile extension entrypoints, and ${resources.skillPaths.length} skill roots selected`,
        ),
      ),
      Effect.catch(() =>
        Effect.succeed(error("resources", "Selected extensions or installed skills are invalid")),
      ),
    );
  });

const piDocsCheck = (): DoctorCheck => {
  const documents = loadPinnedPiDocs();
  return documents.length === 0 || documents.some((document) => document.content.length === 0)
    ? error("pi_docs", "Pinned Pi docs are missing or empty")
    : ok("pi_docs", describePinnedPiDocs(documents));
};

const gatewayCheck = (target: ProfileTarget): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    const configs = [
      ["telegram.json", loadTelegramConfigFile] as const,
      ["discord.json", loadDiscordConfigFile] as const,
      ["slack.json", loadSlackConfigFile] as const,
    ];
    let count = 0;
    for (const [name, load] of configs) {
      const configPath = path.join(target.path, name);
      if (!(yield* gatewayConfigPresent(configPath))) continue;
      count += 1;
      yield* load(target);
    }
    return ok("gateways", `${count} present gateway config file${count === 1 ? "" : "s"} valid`);
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(error("gateways", "A present gateway config file is invalid or unreadable")),
    ),
  );

const sessionsCheck = (target: ProfileTarget): Effect.Effect<DoctorCheck> =>
  listProfileSessions(target.path).pipe(
    Effect.map((sessions) => {
      const broken = sessions.filter((session) => session.parentUnknown).length;
      return broken > 0
        ? warn(
            "sessions",
            `${sessions.length} readable Pi session file${sessions.length === 1 ? "" : "s"}; ${broken} broken parent link${broken === 1 ? "" : "s"}`,
          )
        : ok(
            "sessions",
            `${sessions.length} readable Pi session file${sessions.length === 1 ? "" : "s"}`,
          );
    }),
    Effect.catch(() =>
      Effect.succeed(error("sessions", "Pi session metadata is invalid or unreadable")),
    ),
  );

const slackRuntimeCheck = (target: ProfileTarget): Effect.Effect<DoctorCheck> =>
  readSlackHealth(target.path, Date.now()).pipe(
    Effect.map((projection) => {
      if (projection._tag === "not-configured") {
        return ok("slack-runtime", "Slack is not configured");
      }
      if (projection._tag === "not-observed") {
        return warn("slack-runtime", "Slack is configured but has no runtime observation");
      }
      const { snapshot } = projection;
      const stale =
        snapshot.updatedAtMs > projection.observedAtMs ||
        projection.observedAtMs - snapshot.updatedAtMs > 90_000;
      if (stale) return warn("slack-runtime", "Slack runtime observation is stale");
      if (snapshot.state === "connected") {
        return ok(
          "slack-runtime",
          `Slack is connected; ${snapshot.activeTurnCount} active and ${snapshot.queuedTurnCount} queued turn${snapshot.queuedTurnCount === 1 ? "" : "s"}`,
        );
      }
      if (snapshot.state === "failed") {
        return error(
          "slack-runtime",
          `Slack runtime failed (${snapshot.lastFailure ?? "unknown"})`,
        );
      }
      return warn("slack-runtime", `Slack runtime is ${snapshot.state}`);
    }),
    Effect.catch(() =>
      Effect.succeed(error("slack-runtime", "Slack runtime observation is invalid or unreadable")),
    ),
  );

const discordRuntimeCheck = (target: ProfileTarget): Effect.Effect<DoctorCheck> =>
  readDiscordHealth(target.path, Date.now()).pipe(
    Effect.map((projection) => {
      if (projection._tag === "not-configured") {
        return ok("discord-runtime", "Discord is not configured");
      }
      if (projection._tag === "not-observed") {
        return warn("discord-runtime", "Discord is configured but has no runtime observation");
      }
      const { snapshot } = projection;
      const stale =
        snapshot.updatedAtMs > projection.observedAtMs ||
        projection.observedAtMs - snapshot.updatedAtMs > 90_000;
      if (stale) return warn("discord-runtime", "Discord runtime observation is stale");
      if (snapshot.state === "connected") {
        return ok(
          "discord-runtime",
          `Discord is connected; ${snapshot.activeTurnCount} active and ${snapshot.queuedTurnCount} queued turn${snapshot.queuedTurnCount === 1 ? "" : "s"}`,
        );
      }
      if (snapshot.state === "failed") {
        return error(
          "discord-runtime",
          `Discord runtime failed (${snapshot.lastFailure ?? "unknown"})`,
        );
      }
      return warn("discord-runtime", `Discord runtime is ${snapshot.state}`);
    }),
    Effect.catch(() =>
      Effect.succeed(
        error("discord-runtime", "Discord runtime observation is invalid or unreadable"),
      ),
    ),
  );

const runtimeCheck = (target: ProfileTarget): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    const runtimePath = path.join(target.path, ".runtime");
    const status = yield* Effect.result(inspect(runtimePath));
    if (status._tag === "Failure")
      return isMissing(status.failure)
        ? ok("runtime", "Resident runtime directory has not been created")
        : error("runtime", "Resident runtime directory is unreadable");
    return status.success.isDirectory() && !status.success.isSymbolicLink()
      ? ok("runtime", "Resident runtime directory is readable")
      : error("runtime", "Resident runtime path must be a regular directory");
  });

export const makeDoctor = (
  auth: AuthApi,
  models: ModelsApi,
  catalog?: ExtensionCatalogApi,
): DoctorApi => ({
  check: (target, repositoryRoot) =>
    Effect.gen(function* () {
      const checks = [
        ok("ziggy", `Ziggy ${packageJson.version}`),
        yield* profileCheck(target),
        yield* modelCheck(target, models),
        yield* authCheck(target, auth, models),
        yield* agentsCheck(target, models),
        yield* automationsCheck(target),
        yield* memoryCheck(target),
        yield* resourcesCheck(target, repositoryRoot, catalog),
        piDocsCheck(),
        yield* gatewayCheck(target),
        yield* discordRuntimeCheck(target),
        yield* slackRuntimeCheck(target),
        yield* sessionsCheck(target),
        yield* runtimeCheck(target),
      ];
      return doctorReport(target.path, checks);
    }),
});

export const DoctorLive = Layer.effect(
  Doctor,
  Effect.gen(function* () {
    return makeDoctor(yield* Auth, yield* Models, yield* ExtensionCatalogService);
  }),
);
