# Voice

Hold the button, speak, let go: the device shows what you said and then Ziggy's answer — and,
past Muse, says it out loud.

## Behaviors

- **V1** A recording (16 kHz PCM16 mono, 0.3–20 s, streamed in chunks on an odd stream) reaches
  the hub and is transcribed by the Profile's `speech.transcribe` command.
- **V2** The device gets `{turn}`, then `chat.transcript` with the text, and the text is the turn's
  user message.
- **V3** The reply streams as for typed text.
- **V4** On a device that plays `mp3`, with `speech.speak` set, the reply to a spoken turn
  follows as `audio.play` MP3. A typed turn's reply is not spoken.
- **V5** Under 0.3 s, over 20 s, no speech heard, or a failing engine: the request is refused and
  no turn starts.
- **V6** Without `speech.transcribe` in `devices.json`, audio is refused with a hint (`-32002`).

## User entry points

- `ziggy-device` stdin: `/audio <file.wav>`. `ZiggyDevice.sendAudio(pcm)` in code.
- BOX-3 push-to-talk (S7, not built).

## Drive

Tests: `bun test test/e2e/device-voice.test.ts` (V1–V5 with script engines: one names the WAV size,
the other writes `ID3` and the text) and `bun test test/e2e/device-chat.test.ts` (V6).

By hand, with a real local engine, after the SKILL.md launch steps (sandbox, `devices configure`):

1. Get the engine: `whisper-cli` (`brew install whisper-cpp`) and a model, e.g.
   `curl -sSL -o /tmp/ggml-tiny.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin`.
2. Add to `"$PROFILE/devices.json"`:
   `"speech": {"transcribe": {"command": ["whisper-cli", "-m", "/tmp/ggml-tiny.en.bin", "-nt", "-np", "-f", "{wav}"]}}`.
   For V4 add a speaker to `speech`, here macOS `say` and ffmpeg:
   `"speak": {"command": ["/bin/sh", "-c", "say -o \"$0.aiff\" \"$1\" && ffmpeg -loglevel error -y -i \"$0.aiff\" -ac 1 -b:a 48k \"$0\"", "{mp3}", "{text}"]}`.
   Then start `serve`; the hub reads it at start.
3. Make recordings: `say -o light.wav --data-format=LEI16@16000 "Turn on the kitchen light please."`
   and a too-short one, `ffmpeg -i light.wav -t 0.1 -c:a pcm_s16le short.wav`.
4. Pair and `run` `ziggy-device --speaker heard` with a fifo on stdin, then write
   `/audio short.wav`, `/audio light.wav` and a typed line to it.
5. Listen to `heard/audio-1.mp3`, or transcribe it back:
   `ffmpeg -i heard/audio-1.mp3 -ac 1 -ar 16000 -c:a pcm_s16le a.wav && whisper-cli -m /tmp/ggml-tiny.en.bin -nt -np -f a.wav`.

A full script: `drive.sh` in `/tmp/ziggy-devices-proof/s9-20261003-150121`.

## Proof

- `run.out`: `chat refused: chat.send: a recording must last at least 0.3 seconds`, then
  `chat t1 transcript Turn on the kitchen light please.` before `chat t1 thinking` and
  `chat t1 done …`.
- `run.out`: `audio mp3 <n> bytes saved …/audio-1.mp3` after `chat t1 done`, and none after the
  typed turn's `done`.
- The clip transcribed back says the reply's text.
- `model-requests.jsonl`: the transcript is the user message; the refusal reached no model.

## Gotchas

- The hub reads `devices.json` when the resident starts; restart it after changing `speech`.
- A speaker that fails or writes something that is not an MP3 is logged in the resident's log
  (`could not speak a reply`); the device still has the text.
- whisper-cli prints a leading space and a newline; the hub trims stdout.
- The sandbox flushes model requests every 100 ms; wait for the file before copying it.
- A cloud engine costs money and sends the recording off the machine; tests and the recipe use a
  script or a local engine.
