/**
 * Speech for devices. A device records PCM16 mono at 16 kHz; a Profile's `devices.json` names
 * the command that turns a recording into text (`speech.transcribe`).
 */
import { Effect, Schema } from "effect";

export class SpeechFailed extends Schema.TaggedErrorClass<SpeechFailed>()("SpeechFailed", {
  message: Schema.String,
}) {}

/** Turns a PCM16 mono 16 kHz recording into text; empty text means nothing was heard. */
export type Transcriber = (pcm: Uint8Array) => Effect.Effect<string, SpeechFailed>;

export const PCM_SAMPLE_RATE = 16_000;

/** PCM16 mono: 2 bytes per sample. */
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;

/** Recordings outside 0.3–20 s are refused before they are transcribed. */
export const MIN_RECORDING_BYTES = Math.round(PCM_BYTES_PER_SECOND * 0.3);

export const MAX_RECORDING_BYTES = PCM_BYTES_PER_SECOND * 20;

/** The recording as a WAV file, which every speech-to-text program reads. */
export const wavFromPcm16 = (pcm: Uint8Array, sampleRate = PCM_SAMPLE_RATE): Uint8Array => {
  const wav = new Uint8Array(44 + pcm.length);

  const view = new DataView(wav.buffer);

  const ascii = (offset: number, text: string) =>
    [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);

  return wav;
};

/** Turns a reply into MP3 audio for a device to play. */
export type Speaker = (text: string) => Effect.Effect<Uint8Array, SpeechFailed>;

/** Several minutes of speech at the bitrates a speaker writes. */
export const MAX_SPOKEN_BYTES = 8 * 1_024 * 1_024;

/** Starts with an ID3 tag or an MPEG audio frame. */
export const isMp3 = (bytes: Uint8Array): boolean =>
  (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
  (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
