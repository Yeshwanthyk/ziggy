---
name: telephony
description: "Use Ziggy or Pi for phone workflows through Twilio, Bland.ai, or Vapi: provision and persist an owned number, send or receive SMS/MMS, make direct calls, and place AI-driven outbound calls."
---

# Telephony

Use the bundled helper for optional phone capabilities without adding runtime tools. It uses Python's standard-library HTTP clients and supports:

- Twilio number search, purchase, persistence, SMS/MMS, inbox polling, and direct calls
- Twilio TwiML `<Say>` and `<Play>`
- importing an owned Twilio number into Vapi
- outbound conversational calls through Bland.ai or Vapi

Inbound SMS uses polling, not a webhook. This skill does not provide real-time inbound call answering.

## Safety

1. Confirm immediately before placing a call, buying a number, or sending a message.
2. Never dial emergency numbers.
3. Do not support harassment, spam, impersonation, or illegal activity.
4. Treat third-party phone numbers as sensitive operational data. Do not persist them in Profile memory or summaries unless the user explicitly requests it.
5. Persisting the user-controlled Twilio number and provider IDs is allowed as configuration.
6. Explain that VoIP numbers are not accepted by every third-party verification service.

## Locate the helper

Resolve the helper relative to this file, following Pi's skill-relative path rule:

```bash
SKILL_DIR="$(dirname "<absolute-path-to-this-SKILL.md>")"
SCRIPT="$SKILL_DIR/scripts/telephony.py"
```

Use that absolute `SCRIPT` path for every command below. When Ziggy installs the skill with `ziggy skills add`, the helper remains in the copied skill tree.

## Persistent configuration

By default, the helper stores Profile-local data under `.runtime/telephony/` in the current Profile directory:

- `.env` contains provider credentials and owned-number IDs.
- `telephony_state.json` contains the default Twilio number, Vapi phone-number ID, and inbox checkpoint.

Set `ZIGGY_TELEPHONY_HOME` to choose a different directory. Process environment variables take precedence over values in `.env`.

Relevant keys include:

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`, `TWILIO_PHONE_NUMBER_SID`
- `BLAND_API_KEY`, `BLAND_DEFAULT_VOICE`
- `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`
- `VAPI_VOICE_PROVIDER`, `VAPI_VOICE_ID`, `VAPI_MODEL`
- `PHONE_PROVIDER` (`bland` or `vapi`)

Run this first when resuming:

```bash
python3 "$SCRIPT" diagnose
```

## Choose a provider

Use Twilio when the user wants to own a reusable number, send SMS/MMS, poll received messages, or make a direct one-way call.

Use Bland.ai for the shortest setup path to an outbound conversational AI call.

Use Twilio plus Vapi when the user wants an owned number and a higher-quality conversational voice workflow:

1. Buy or select a Twilio number.
2. Import it into Vapi.
3. Persist the returned `VAPI_PHONE_NUMBER_ID`.
4. Call with `ai-call --provider vapi`.

## Provider setup

Create a Twilio account at https://www.twilio.com/try-twilio, then save credentials:

```bash
python3 "$SCRIPT" save-twilio ACXXXXXXXXXXXXXXXXXXXXXXXXXXXX auth_token_here
```

Search for and buy a number:

```bash
python3 "$SCRIPT" twilio-search --country US --area-code 702 --limit 5
python3 "$SCRIPT" twilio-buy "+17025551234" --save-env
```

List owned numbers or select a different default:

```bash
python3 "$SCRIPT" twilio-owned
python3 "$SCRIPT" twilio-set-default "+17025551234" --save-env
python3 "$SCRIPT" twilio-set-default PNXXXXXXXXXXXXXXXXXXXXXXXXXXXX --save-env
```

Create a Bland.ai account at https://app.bland.ai, then save its API key:

```bash
python3 "$SCRIPT" save-bland bland_api_key_here --voice mason
```

Create a Vapi account at https://dashboard.vapi.ai, then save its API key:

```bash
python3 "$SCRIPT" save-vapi vapi_api_key_here
```

Import the saved Twilio number:

```bash
python3 "$SCRIPT" vapi-import-twilio --save-env
```

Or save a known Vapi phone-number ID:

```bash
python3 "$SCRIPT" save-vapi vapi_api_key_here --phone-number-id vapi_phone_number_id_here
```

## SMS and MMS

Send text:

```bash
python3 "$SCRIPT" twilio-send-sms "+15551230000" "Your deployment completed successfully."
```

Send media:

```bash
python3 "$SCRIPT" twilio-send-sms "+15551230000" "Here is the chart." \
  --media-url "https://example.com/chart.png"
```

Poll received messages:

```bash
python3 "$SCRIPT" twilio-inbox --limit 20
python3 "$SCRIPT" twilio-inbox --since-last --mark-seen
```

The second form reads after the saved checkpoint and advances it.

## Direct calls

Use Twilio's built-in text-to-speech:

```bash
python3 "$SCRIPT" twilio-call "+15551230000" \
  --message "Hello! This is Ziggy calling with your status update." \
  --voice Polly.Joanna
```

Play prerecorded audio from a public HTTPS URL:

```bash
python3 "$SCRIPT" twilio-call "+15551230000" \
  --audio-url "https://example.com/briefing.mp3"
```

Generate audio with an available speech tool or external service, publish it at a short-lived URL the provider can fetch, then use `--audio-url`. Twilio `<Play>` is suitable for one-way delivery; Bland.ai or Vapi is more suitable for a live conversation.

Navigate an IVR with digits; Twilio interprets `w` as a short wait:

```bash
python3 "$SCRIPT" twilio-call "+18005551234" \
  --message "Connecting to billing now." \
  --send-digits "ww1w2w3"
```

## Conversational AI calls

Place a Bland.ai call:

```bash
python3 "$SCRIPT" ai-call "+15551230000" \
  "Ask for a cleaning appointment Tuesday afternoon; otherwise ask for Wednesday." \
  --provider bland --voice mason --max-duration 3
```

Check status or request structured analysis:

```bash
python3 "$SCRIPT" ai-status <call_id> --provider bland
python3 "$SCRIPT" ai-status <call_id> --provider bland \
  --analyze "Was the appointment confirmed?,What date and time?"
```

Place a Vapi call from the imported number:

```bash
python3 "$SCRIPT" ai-call "+15551230000" \
  "Make a dinner reservation for two at 7:30 PM." \
  --provider vapi --max-duration 4
python3 "$SCRIPT" ai-status <call_id> --provider vapi
```

## Agent procedure

1. Select the provider that fits the request.
2. Run `diagnose` if configuration is unclear.
3. Collect recipient, content, timing, and fallback details.
4. Confirm the exact external action with the user.
5. Run the helper and poll status when needed.
6. Report the outcome without persisting third-party phone numbers.

## Limits and pitfalls

- Twilio trial accounts and regional rules may restrict recipients.
- Some services reject VoIP numbers for verification.
- Inbox polling is not instant push delivery.
- Vapi calling requires a valid imported number.
- The helper does not implement webhook delivery or full-duplex inbound calls.

## References

- Twilio phone numbers: https://www.twilio.com/docs/phone-numbers/api
- Twilio messaging: https://www.twilio.com/docs/messaging/api/message-resource
- Twilio voice: https://www.twilio.com/docs/voice/api/call-resource
- Vapi: https://docs.vapi.ai/
- Bland.ai: https://app.bland.ai/
