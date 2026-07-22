const decoder = new TextDecoder();
const tsc = "./node_modules/.bin/tsc";

const run = (command: ReadonlyArray<string>) => {
  const result = Bun.spawnSync({
    cmd: [...command],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
};

const packageSource = await Bun.file("node_modules/@effect/tsgo/package.json").text();
const version = /"version"\s*:\s*"([^"]+)"/.exec(packageSource)?.[1];
if (version === undefined) throw new Error("Could not read @effect/tsgo version");

const expectedMarker = `+effect-tsgo.${version}`;
const before = run([tsc, "--version"]);

if (before.exitCode === 0 && before.stdout.includes(expectedMarker)) {
  console.log(`Effect TSGO already active: ${before.stdout}`);
  process.exit(0);
}

const patched = run(["./node_modules/.bin/effect-tsgo", "patch"]);
if (patched.exitCode !== 0) {
  throw new Error(patched.stderr || patched.stdout || "effect-tsgo patch failed");
}

const after = run([tsc, "--version"]);
if (after.exitCode !== 0 || !after.stdout.includes(expectedMarker)) {
  throw new Error(after.stderr || `Effect TSGO activation failed: ${after.stdout}`);
}

console.log(`Effect TSGO activated: ${after.stdout}`);
