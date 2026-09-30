/** Reads a Pi session `.jsonl` file into the few fields proofs assert on. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { sessionFiles } from "./profile";

const Entry = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  parentSession: Schema.optional(Schema.String),
  customType: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.String,
      content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Json)])),
    }),
  ),
});

type Entry = typeof Entry.Type;

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(Entry));

export interface Transcript {
  readonly file: string;
  readonly header: Entry;
  readonly entries: ReadonlyArray<Entry>;
  /** `role` of every `message` entry, system prompts excluded. */
  readonly roles: ReadonlyArray<string>;
  /** Every message's content as JSON, joined, for substring checks. */
  readonly text: string;
}

export const readTranscript = async (profilePath: string, file: string): Promise<Transcript> => {
  const raw = await readFile(join(profilePath, "sessions", file), "utf8");

  const [header, ...entries] = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeLine(line));

  if (header === undefined) throw new Error(`${file} is empty`);

  const messages = entries.flatMap((entry) =>
    entry.type === "message" && entry.message !== undefined && entry.message.role !== "system"
      ? [entry.message]
      : [],
  );

  return {
    file,
    header,
    entries,
    roles: messages.map((message) => message.role),
    text: messages.map((message) => JSON.stringify(message.content ?? null)).join("\n"),
  };
};

/** The Profile's only session file; fails the proof when there is not exactly one. */
export const onlyTranscript = async (profilePath: string): Promise<Transcript> => {
  const files = await sessionFiles(profilePath);

  if (files.length !== 1) throw new Error(`expected one session file, found ${files.join(", ")}`);

  return readTranscript(profilePath, files[0] ?? "");
};

/** The session id Pi wrote in the header. */
export const sessionId = (transcript: Transcript): string => {
  if (transcript.header.id === undefined) throw new Error(`${transcript.file} has no session id`);

  return transcript.header.id;
};
