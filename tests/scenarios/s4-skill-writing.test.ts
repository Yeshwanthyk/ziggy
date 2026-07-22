import { expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
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
  createS4ExtensionFixture,
  installS4Fixture,
  useS4Lifecycle,
} from "../testkit/s4-extension-fixture.ts";
import {
  emitVerificationObservation,
  emptyRuntimeObservations,
} from "../testkit/verification-observations.ts";

test("baked-in skill-writing metadata is valid and precedes installed Extension Skills", async () => {
  const fixture = await createS4ExtensionFixture("core-skill-writing", {
    files: {
      "skills/fixture/SKILL.md":
        "---\nname: fixture\ndescription: Installed Skill ordering sentinel\n---\n\nEXTENSION_SKILL_ORDERING_SENTINEL\n",
    },
  });
  const profilePath = fixture.profile;
  const runtimeScope = await runEffect(Scope.make());
  try {
    await Promise.all([
      mkdir(join(profilePath, "credentials"), { mode: 0o700 }),
      mkdir(join(profilePath, "sessions")),
      mkdir(join(profilePath, "memory")),
    ]);
    await chmod(join(profilePath, "credentials"), 0o700);
    await writeFile(join(profilePath, "SOUL.md"), "fixture soul\n");

    const skill = await runEffect(loadCoreSkillWriting);
    expect(skill.id).toBe(CORE_SKILL_WRITING_ID);
    expect(skill.description).toContain("conformant Ziggy Skills");
    expect(skill.content).toStartWith("---\nname: skill-writing\n");
    expect(skill.content).toContain("## Review checklist");

    const installed = await installS4Fixture(profilePath, fixture.source, []);
    expect(installed).toMatchObject({
      status: "installed",
      extension: { id: "fixture", enabled: false },
    });
    const enabled = await useS4Lifecycle(profilePath, (service) =>
      service.enable({ extensionId: "fixture", approvals: [] }),
    );
    expect(enabled).toMatchObject({
      status: "enabled",
      extension: { id: "fixture", enabled: true },
    });

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
    expect(observedPrompt).toContain('<skill id="fixture">');
    expect(observedPrompt).toContain("EXTENSION_SKILL_ORDERING_SENTINEL");
    const coreSkillPosition = observedPrompt.indexOf('<skill id="skill-writing">');
    const extensionSkillPosition = observedPrompt.indexOf('<skill id="fixture">');
    expect(coreSkillPosition).toBeGreaterThanOrEqual(0);
    expect(extensionSkillPosition).toBeGreaterThan(coreSkillPosition);
    emitVerificationObservation("s4.skill-writing", {
      ...emptyRuntimeObservations(),
      metrics: [
        { name: "core-skills-injected", value: 1 },
        { name: "enabled-extension-skills-injected", value: 1 },
        { name: "execution-approval-requirements", value: 0 },
        { name: "skill-ordering-byte-gap", value: extensionSkillPosition - coreSkillPosition },
        { name: "provider-calls", value: faux.state.callCount },
      ],
    });
  } finally {
    await runEffect(Scope.close(runtimeScope, Exit.void));
    await rm(fixture.root, { recursive: true, force: true });
  }
});
