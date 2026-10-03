/**
 * A scratch Ziggy for driving by hand: a scripted model server plus a Profile wired to it, in a tmp
 * `ZIGGY_HOME`. Prints the environment to export, logs every model request to
 * `<root>/model-requests.jsonl`, and on SIGINT/SIGTERM stops the server. The home is kept as
 * evidence; delete it when done.
 *
 *   bun test/harness/sandbox.ts
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { startModelServer } from "./provider";
import { scratchProfile } from "./profile";

const server = startModelServer();

const profile = await scratchProfile(server);

const log = join(profile.root, "model-requests.jsonl");

let logged = 0;

const flush = async (): Promise<void> => {
  const fresh = server.rawRequests.slice(logged);
  logged += fresh.length;

  if (fresh.length > 0) await appendFile(log, fresh.map((body) => `${body}\n`).join(""));
};

const ticker = setInterval(() => void flush(), 100);

console.log(`export ZIGGY_HOME=${profile.home}`);

console.log(`SCRATCH_HOME=${profile.root}`);

console.log(`PROFILE=${profile.path}`);

console.log(`MODEL_URL=${server.baseUrl}`);

console.log(`REQUESTS=${log}`);

console.log("ready");

const stop = async () => {
  clearInterval(ticker);
  await flush();
  server.stop();
  console.log(`stopped; evidence kept in ${profile.root}`);
  process.exit(0);
};

process.on("SIGINT", () => void stop());

process.on("SIGTERM", () => void stop());
