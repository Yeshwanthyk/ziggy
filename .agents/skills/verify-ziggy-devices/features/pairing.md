# Pairing

The user gets a one-time code from Ziggy, enters it on the device, and the device belongs to that
Profile.

## Behaviors

- **P1** `ziggy devices pair <profile>` prints a code and an expiry.
- **P2** The device redeems the code; both sides store the other's static public key.
- **P3** The same code cannot be redeemed twice or after expiry.
- **P4** `ziggy devices list` shows the device; `rename` changes its name; `revoke` removes it.
- **P5** The registry file holds no private key or secret.

## User entry points

- CLI code pairing with the harness fake or `ziggy-device pair <code>` on a Pi.
- `ziggy devices pair --serial <port>` for an ESP32 (see [hardware](hardware.md)).
- Web Bluetooth (S11) — not planned here yet.

## Drive

Not built (S2, S3). Planned: write `devices.json`, start the resident, run `devices pair`, then
`startDevice(resident, {code})`; redeem the same code again with a second fake.

## Proof

CLI stdout; `$PROFILE/devices/<id>.json` before and after; the second redeem's refusal frame;
`grep -ri private "$PROFILE/devices"` prints nothing.

## Gotchas

- A pairing code is a secret for its lifetime: redact it in saved stdout.
