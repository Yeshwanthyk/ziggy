# Voice

Hold the button, speak, let go: the device shows what you said and then Ziggy's answer — and,
past Muse, says it out loud.

## Behaviors

- **V1** PTT audio (16 kHz PCM16, 0.3–20 s) reaches the hub and is transcribed.
- **V2** The transcript is shown on the device and sent as the turn's user text.
- **V3** The reply streams on screen; first text within 60 s.
- **V4** The reply is spoken (`audio.play` MP3) (S9).
- **V5** A clip under 0.3 s or silence gets a "didn't catch that", not an empty turn.

## User entry points

- BOX-3 button; harness fake sending a WAV fixture.

## Drive

Not built (S8, S9). Planned: fake sends a fixed WAV whose transcript is known; scripted model
replies; then the BOX-3 by hand.

## Proof

Transcript text vs the fixture's known text; `$REQUESTS` user message; screen photo; audio
recording for V4.

## Gotchas

- A cloud STT call costs money and leaves the machine; the fixture path must use the local or a
  stub engine.
