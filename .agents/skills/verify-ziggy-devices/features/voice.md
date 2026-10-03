# Voice

Hold the button, speak, let go: the device shows what you said and then Ziggy's answer — and,
past Muse, says it out loud.

## Behaviors

- **V1** A recording (16 kHz PCM16 mono, 0.3–20 s, streamed in chunks on an odd stream) reaches
  the hub and is transcribed by the Profile's `speech.transcribe` command.
- **V2** The device gets `{turn}`, then `chat.transcript` with the text, and the text is the turn's
  user message.
- **V3** The reply streams as for typed text.
- **V4** The reply is spoken (`audio.play` MP3) (S9, not built).
- **V5** Under 0.3 s, over 20 s, no speech heard, or a failing engine: the request is refused and
  no turn starts.
- **V6** Without `speech.transcribe` in `devices.json`, audio is refused with a hint (`-32002`).

## User entry points

- `ziggy-device` stdin: `/audio <file.wav>`. `ZiggyDevice.sendAudio(pcm)` in code.
- BOX-3 push-to-talk (S7, not built).

## Drive

Tests: `bun test test/e2e/device-voice.test.ts` (V1–V3, V5 with a script engine that names the WAV
size) and `bun test test/e2e/device-chat.test.ts` (V6).

By hand, with a real local engine, after the SKILL.md launch steps (sandbox, `devices configure`):

1. Get the engine: `whisper-cli` (`brew install whisper-cpp`) and a model, e.g.
   `curl -sSL -o /tmp/ggml-tiny.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin`.
2. Add to `"$PROFILE/devices.json"`:
   `"speech": {"transcribe": {"command": ["whisper-cli", "-m", "/tmp/ggml-tiny.en.bin", "-nt", "-np", "-f", "{wav}"]}}`.
   Then start `serve`; the hub reads it at start.
3. Make recordings: `say -o light.wav --data-format=LEI16@16000 "Turn on the kitchen light please."`
   and a too-short one, `ffmpeg -i light.wav -t 0.1 -c:a pcm_s16le short.wav`.
4. Pair and `run` `ziggy-device` with a fifo on stdin, then write `/audio short.wav` and
   `/audio light.wav` lines to it.

A full script: `drive.sh` in `/tmp/ziggy-devices-proof/s8-20261003-145555`.

## Proof

- `run.out`: `chat refused: chat.send: a recording must last at least 0.3 seconds`, then
  `chat t1 transcript Turn on the kitchen light please.` before `chat t1 thinking` and
  `chat t1 done …`.
- `model-requests.jsonl`: the transcript is the user message; one request (the refusal reached no
  model).

## Gotchas

- The hub reads `devices.json` when the resident starts; restart it after changing `speech`.
- whisper-cli prints a leading space and a newline; the hub trims stdout.
- The sandbox flushes model requests every 100 ms; wait for the file before copying it.
- A cloud engine costs money and sends the recording off the machine; tests and the recipe use a
  script or a local engine.
