# Web access ownership

The resident that owns a Profile also owns its loopback web server and browser authorization. The
server always binds to `127.0.0.1`; a remote HTTPS service such as Tailscale proxies to that local
port.

## Durable state

The owner Profile's `.gateway/` directory contains the state that survives resident restarts:

- `web.json` stores the configured local port and optional public origin.
- `web-access.sqlite` stores hashed, single-use pairing tokens and hashed browser sessions.

Pairing tokens expire after 10 minutes. Browser sessions expire after 30 days or when
`ziggy web revoke <owner-profile>` revokes all active sessions for that gateway.

## Runtime projection

On startup, the resident binds the configured loopback port and writes `.runtime/ui-server.json`.
That file is an ephemeral projection containing the actual port and a newly generated SDK bearer
token. A matching projection is removed on normal shutdown. The browser cookie is validated against
the durable access database, so it remains valid when the resident and runtime projection restart.

A missing `web.json` currently falls back to port `0`, allowing the OS to choose an ephemeral port.
Because `web pair` builds its local URL from the configuration rather than the runtime projection,
0.2.6 can print `http://127.0.0.1:0`. Browser operation therefore requires explicit configuration
with `ziggy web configure`.

## Shared gateway scope

The resident composes available registered Profiles into one UI gateway. The owner Profile selects
the process, port, configuration, access database, and browser cookie namespace; it does not limit
the gateway to that Profile. One authenticated browser can select any available Profile exposed by
that gateway, while each Profile keeps its own chat registry and Profile-owned state.

This is gateway authentication, not a per-Profile ACL. Separate residents, loopback ports, origins,
and cookies create separate gateway credentials, but they do not isolate Profiles if those gateways
compose the same registered Profile directory. Profile isolation also requires distinct exposure
sets rather than only distinct listeners.
