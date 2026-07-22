import { expect, test } from "bun:test";
import { Result } from "effect";
import { runtimeInvocation, serveArgv } from "../../packages/ziggy/src/executable.ts";

test("compiled Bun entrypoints invoke the executable directly", () => {
  const runtime = Result.getOrThrow(runtimeInvocation("/$bunfs/root/ziggy", "/opt/ziggy"));
  expect(runtime).toEqual({ kind: "compiled", executable: "/opt/ziggy" });
  expect(serveArgv(runtime, "/profile")).toEqual(["/opt/ziggy", "serve", "--profile", "/profile"]);
});

test("source entrypoints invoke Bun with the source file", () => {
  const runtime = Result.getOrThrow(
    runtimeInvocation("/repo/packages/ziggy/src/main.ts", "/opt/homebrew/bin/bun"),
  );
  expect(runtime).toEqual({
    kind: "source",
    executable: "/opt/homebrew/bin/bun",
    entrypoint: "/repo/packages/ziggy/src/main.ts",
  });
  expect(serveArgv(runtime, "/profile")).toEqual([
    "/opt/homebrew/bin/bun",
    "/repo/packages/ziggy/src/main.ts",
    "serve",
    "--profile",
    "/profile",
  ]);
});

test("an unavailable source entrypoint fails instead of guessing argv", () => {
  expect(runtimeInvocation("", "/opt/homebrew/bin/bun")).toEqual(
    Result.fail(
      expect.objectContaining({
        _tag: "RuntimeInvocationError",
        message: "Cannot locate the Ziggy source entry point",
      }),
    ),
  );
});
