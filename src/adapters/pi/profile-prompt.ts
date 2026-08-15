import { basename } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { ProviderConfigError } from "../../domain/agent";
import agentsMarkdown from "../../../skills/AGENTS.md" with { type: "file" };

export const PROFILE_AGENTS_NAME_TOKEN = "{{profile}}";
export const profileAgentsPath: string = `${agentsMarkdown}`;

export const fillProfileAgentsPrompt = (template: string, profileName: string): string =>
  template.replaceAll(PROFILE_AGENTS_NAME_TOKEN, profileName).trim();

export const composeProfileSystemPrompt = (agentsPrompt: string, soul: string): string =>
  `${agentsPrompt.trim()}\n\n${soul}`;

const readUtf8 = (path: string, profilePath: string, operation: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderConfigError({
            profilePath,
            operation,
            message: `could not read ${path}`,
            cause,
          }),
      ),
    );
  });

const readAgentsPrompt = (profilePath: string) =>
  readUtf8(profileAgentsPath, profilePath, "read AGENTS.md").pipe(
    Effect.map((template) => fillProfileAgentsPrompt(template, basename(profilePath))),
  );

const withHostFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E> => effect.pipe(Effect.provide(BunFileSystem.layer));

export const loadProfileAgentsPrompt = (
  profilePath: string,
): Effect.Effect<string, ProviderConfigError> => withHostFileSystem(readAgentsPrompt(profilePath));

export const loadProfileSystemPrompt = (
  profilePath: string,
  soulPath: string,
): Effect.Effect<string, ProviderConfigError> =>
  withHostFileSystem(
    Effect.gen(function* () {
      const agentsPrompt = yield* readAgentsPrompt(profilePath);
      const soul = yield* readUtf8(soulPath, profilePath, "read system prompt");
      return composeProfileSystemPrompt(agentsPrompt, soul);
    }),
  );
