import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Effect, Exit, Scope } from "effect";
import {
  createFilesystemWorld,
  createProfileCredentialStore,
  createProviderRuntimeComposition,
} from "../../packages/core/src/index.ts";
import {
  CORE_SKILL_WRITING_ID,
  loadCoreSkillWriting,
} from "../../packages/core/src/skills/skill-writing/index.ts";
import { runEffect } from "../testkit/effect.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

test("baked-in skill-writing metadata is valid and precedes installed Extension Skills", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "ziggy-core-skill-writing-"));
  const runtimeScope = await runEffect(Scope.make());
  try {
    await Promise.all([
      mkdir(join(profilePath, "credentials"), { mode: 0o700 }),
      mkdir(join(profilePath, "sessions")),
      mkdir(join(profilePath, "memory")),
      mkdir(join(profilePath, "extensions")),
    ]);
    await chmod(join(profilePath, "credentials"), 0o700);
    await writeFile(join(profilePath, "SOUL.md"), "fixture soul\n");

    const skill = await runEffect(loadCoreSkillWriting);
    expect(skill.id).toBe(CORE_SKILL_WRITING_ID);
    expect(skill.description).toContain("conformant Ziggy Skills");
    expect(skill.content).toStartWith("---\nname: skill-writing\n");
    expect(skill.content).toContain("## Review checklist");

    const credentials = await runEffect(
      createProfileCredentialStore(profilePath).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
      ),
    );
    const faux = fauxProvider({
      provider: "skill-provider",
      models: [{ id: "skill-model", name: "Skill Model" }],
    });
    const models = createModels({ credentials });
    models.setProvider(faux.provider);
    let observedPrompt = "";
    faux.setResponses([
      (context) => {
        observedPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("skill-writing-ready");
      },
    ]);
    const composition = await runEffect(
      createProviderRuntimeComposition({
        profilePath,
        config: {
          defaultProvider: "skill-provider",
          defaultModel: "skill-model",
          thinkingLevel: "medium",
          cacheRetention: "none",
        },
        credentials,
        models,
      }).pipe(Effect.provideService(Scope.Scope, runtimeScope)),
    );
    const runtime = await runEffect(
      composition
        .createRuntime("skill-session", createFilesystemWorld({ profilePath }))
        .pipe(Effect.provideService(Scope.Scope, runtimeScope)),
    );
    try {
      await runEffect(runtime.startTurn({ message: "Help me write a Skill" }));
      await runEffect(runtime.waitForIdle);
    } finally {
      await runEffect(runtime.close);
    }

    expect(observedPrompt).toStartWith("fixture soul\n");
    expect(observedPrompt).toContain('<skill id="skill-writing">');
    expect(observedPrompt).toContain(skill.content);
    emitVerificationObservation("s4.skill-writing", {
      ...emptyRuntimeObservations(),
      metrics: [
        { name: "core-skills-injected", value: 1 },
        { name: "provider-calls", value: faux.state.callCount },
      ],
    });
  } finally {
    await runEffect(Scope.close(runtimeScope, Exit.void));
    await rm(profilePath, { recursive: true, force: true });
  }
});
