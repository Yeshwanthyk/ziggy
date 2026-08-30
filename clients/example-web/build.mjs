const result = await Bun.build({
  entrypoints: ["clients/example-web/main.ts"],
  outdir: "clients/example-web/dist",
  target: "browser",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
