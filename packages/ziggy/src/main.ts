import { productionDependencies, runCli } from "./cli.ts";

if (import.meta.main) await runCli(Bun.argv.slice(2), productionDependencies());

export { runCli } from "./cli.ts";
export * from "./daemon.ts";
export * from "./service.ts";
