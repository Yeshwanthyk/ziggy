/* oxlint-disable ziggy-effect/no-effect-execution-boundary -- Bun tests are approved Effect execution boundaries */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { deriveResidentServiceIdentity } from "ziggy/domain/resident-service";
import { renderSystemdService } from "ziggy/adapters/bun/systemd-service";
import {
  detectResidentServiceManager,
  inspectManagedDefinition,
  makeResidentPlatformCommands,
  removeManagedDefinition,
  resolveResidentLaunch,
  writeManagedDefinition,
  type ResidentLaunchRuntime,
} from "ziggy/adapters/bun/resident-service";

const temporaryRoot = () => mkdtemp("/tmp/ziggy-resident-service-");

const makeDefinition = (root: string) => {
  const profilePath = join(root, "Profile with spaces");
  const identity = deriveResidentServiceIdentity(profilePath);
  return renderSystemdService({
    identity,
    profilePath,
    launchVector: ["/opt/ziggy/bin", "serve", profilePath],
    home: root,
    ziggyHome: join(root, ".ziggy"),
  });
};

describe("resident service platform adapter", () => {
  test("resolves source and compiled Bun launch vectors deterministically", async () => {
    const paths = new Map([
      ["bun", "/real/bun"],
      ["main", "/real/main.ts"],
      ["profile", "/real/profile"],
    ]);
    const sourceRuntime: ResidentLaunchRuntime = {
      realpath: async (path) => paths.get(path) ?? Promise.reject(new Error("missing")),
      stat: async (path) => ({
        isFile: () => path !== "/real/profile",
        isDirectory: () => path === "/real/profile",
      }),
    };
    const source = await Effect.runPromise(
      resolveResidentLaunch(
        { executablePath: "bun", mainPath: "main", profilePath: "profile" },
        sourceRuntime,
      ),
    );
    const compiled = await Effect.runPromise(
      resolveResidentLaunch(
        { executablePath: "bun", mainPath: "virtual-main", profilePath: "profile" },
        sourceRuntime,
      ),
    );

    expect(source).toEqual({
      profilePath: "/real/profile",
      launchVector: ["/real/bun", "/real/main.ts", "serve", "/real/profile"],
    });
    expect(compiled.launchVector).toEqual(["/real/bun", "serve", "/real/profile"]);
  });

  test("writes atomically, is idempotent, and only force-replaces managed drift", async () => {
    const root = await temporaryRoot();
    try {
      const definition = makeDefinition(root);
      expect(await Effect.runPromise(inspectManagedDefinition(definition))).toEqual({
        _tag: "not-installed",
        path: definition.path,
      });
      expect(await Effect.runPromise(writeManagedDefinition(definition, { force: false }))).toBe(
        "created",
      );
      expect(await Effect.runPromise(writeManagedDefinition(definition, { force: false }))).toBe(
        "unchanged",
      );
      expect(await readFile(definition.path, "utf8")).toBe(definition.content);

      await writeFile(definition.path, `${definition.content}# operator drift\n`, "utf8");
      const refused = await Effect.runPromise(
        writeManagedDefinition(definition, { force: false }).pipe(Effect.result),
      );
      expect(Result.isFailure(refused) && refused.failure.reason).toBe("definition-drift");
      expect(await Effect.runPromise(writeManagedDefinition(definition, { force: true }))).toBe(
        "replaced",
      );
      expect(await readFile(definition.path, "utf8")).toBe(definition.content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes only a recognized managed definition and is idempotent", async () => {
    const root = await temporaryRoot();
    try {
      const definition = makeDefinition(root);
      await Effect.runPromise(writeManagedDefinition(definition, { force: false }));
      expect(await Effect.runPromise(removeManagedDefinition(definition))).toBeTrue();
      expect(await Effect.runPromise(removeManagedDefinition(definition))).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses unmanaged, symlinked, and non-regular destinations even with force", async () => {
    for (const kind of ["unmanaged", "symlink", "directory"] as const) {
      const root = await temporaryRoot();
      try {
        const definition = makeDefinition(root);
        await mkdir(join(definition.path, ".."), { recursive: true });
        if (kind === "unmanaged") await writeFile(definition.path, "operator-owned\n", "utf8");
        if (kind === "symlink") await symlink(join(root, "elsewhere"), definition.path);
        if (kind === "directory") await mkdir(definition.path);
        const result = await Effect.runPromise(
          writeManagedDefinition(definition, { force: true }).pipe(Effect.result),
        );
        expect(Result.isFailure(result) && result.failure.reason).toBe(
          kind === "unmanaged" ? "unmanaged-definition" : "unsafe-definition",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("adapts an injectable argument-array runner into Effect failures", async () => {
    const seen: Array<ReadonlyArray<string>> = [];
    const commands = makeResidentPlatformCommands(async (command) => {
      seen.push(command);
      return { exitCode: 3, stdout: "inactive\n", stderr: "" };
    });
    const result = await Effect.runPromise(
      commands.run(["/usr/bin/systemctl", "--user", "is-active", "unit"]),
    );
    const failed = await Effect.runPromise(
      makeResidentPlatformCommands(async () => Promise.reject(new Error("spawn failed")))
        .run(["/bin/launchctl", "print", "gui/501/unit"])
        .pipe(Effect.result),
    );

    expect(result.exitCode).toBe(3);
    expect(seen).toEqual([["/usr/bin/systemctl", "--user", "is-active", "unit"]]);
    expect(Result.isFailure(failed) && failed.failure.reason).toBe("command");
    expect(await Effect.runPromise(detectResidentServiceManager("darwin"))).toBe("launchd");
    expect(await Effect.runPromise(detectResidentServiceManager("linux"))).toBe("systemd");
  });
});
