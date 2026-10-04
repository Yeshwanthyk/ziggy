/**
 * A scratch Ziggy for driving by hand: a scripted model server plus a Profile wired to it, in a tmp
 * `ZIGGY_HOME`. Prints the environment to export, logs every model request to
 * `<root>/model-requests.jsonl`, and on SIGINT/SIGTERM stops the server. The home is kept as
 * evidence; delete it when done.
 *
 *   bun test/harness/sandbox.ts [--script replies.json]
 *
 * A script is a JSON array of replies taken in order before the default "ok":
 * `{"text": "…"}` or `{"tools": [{"name": "…", "arguments": {…}}]}`.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { type Reply, startModelServer, text, tools } from "./provider";
import { scratchProfile } from "./profile";

const ScriptedReply = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        arguments: Schema.Record(Schema.String, Schema.Json),
      }),
    ),
  }),
]);

const decodeScript = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ScriptedReply)));

const scriptAt = process.argv.indexOf("--script");

const script: ReadonlyArray<Reply> =
  scriptAt === -1
    ? []
    : decodeScript(await readFile(process.argv[scriptAt + 1] ?? "", "utf8")).map((reply) =>
        "text" in reply ? text(reply.text) : tools(...reply.tools),
      );

const server = startModelServer(...script);

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
