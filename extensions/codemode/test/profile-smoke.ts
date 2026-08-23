#!/usr/bin/env bun
/* oxlint-disable ziggy-effect/no-native-promise-ownership -- Disposable test-only Pi loader smoke executable. */
/* oxlint-disable ziggy-effect/no-try-catch-or-throw, ziggy-effect/no-error-constructor -- CLI usage and cleanup failures terminate this disposable smoke. */
/* oxlint-disable ziggy/no-unsafe-typescript-syntax, ziggy/require-safety-comment-for-type-assertion -- Pi's full context is narrowed to cwd for this test-only tool invocation. */
import { join, resolve } from "node:path";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";

const [profileArgument, extensionArgument, codeArgument] = process.argv.slice(2);
if (profileArgument === undefined || extensionArgument === undefined) {
  throw new Error("usage: profile-smoke.ts <profile-path> <installed-codemode-path> [code]");
}

const profilePath = resolve(profileArgument);
const extensionPath = resolve(extensionArgument);
const services = await createAgentSessionServices({
  cwd: profilePath,
  agentDir: profilePath,
  resourceLoaderOptions: {
    systemPrompt: join(profilePath, "SOUL.md"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [extensionPath],
  },
});
const loaded = services.resourceLoader.getExtensions();
const extension = loaded.extensions.find((item) => item.tools.has("codemode_execute"));
const tool = extension?.tools.get("codemode_execute")?.definition;
if (tool === undefined) throw new Error("installed extension did not register codemode_execute");

const context = { cwd: profilePath } as never;
try {
  const response = await tool.execute(
    "profile-smoke",
    { code: codeArgument ?? "return 1;" },
    undefined,
    undefined,
    context,
  );
  console.log(JSON.stringify(response.details));
} finally {
  for (const handler of extension?.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown" }, context);
  }
}
