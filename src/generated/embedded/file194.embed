# Use Ziggy from a browser

Ziggy's web client is served by the resident on loopback. Configure one stable port per resident
before pairing a browser. `squarey` below is the owner Profile passed to `ziggy serve`; it is not a
machine or browser name. The `squarey` examples assume its managed resident is already installed.

For a new Profile and resident, initialize, configure, install, and pair in that order:

```sh
ziggy init my-bot
ziggy web configure my-bot --port 8797
ziggy serve install my-bot
ziggy web pair my-bot
```

`serve install` starts the new resident. Use `serve restart` after changing the configuration of an
already installed resident.

## Local access

For a browser on the same machine, configure the port without a public URL:

```sh
ziggy web configure squarey --port 8797
ziggy serve restart squarey
ziggy web pair squarey
```

Open the URL printed by `web pair`. The pairing code is single-use and expires after 10 minutes.
After pairing, bookmark the base URL without the `#code=...` fragment. The HttpOnly browser cookie
lasts 30 days and remains valid across resident restarts.

## Remote access with Tailscale

Tailscale is optional. Use it when the browser is on another device in your tailnet. Replace
`YOUR-MACHINE.YOUR-TAILNET.ts.net` with this machine's full Tailscale DNS name, then run:

```sh
ziggy web configure squarey --port 8797 --public-url https://YOUR-MACHINE.YOUR-TAILNET.ts.net:4173
ziggy serve restart squarey
tailscale serve --bg --https=4173 http://127.0.0.1:8797
ziggy web pair squarey
```

The Tailscale mapping is backgrounded and persists. You do not repeat `tailscale serve` for each
browser or after each Ziggy restart. Repeat it only when changing the public port, local port, or
machine mapping. The configured public URL must exactly match the origin the browser uses.

## Pairing additional browsers

Run `ziggy web pair squarey` once for each new browser or device. Each command creates a new
single-use link; opening the same link twice does not pair a second browser. Private-browsing
windows lose their session when the private session ends and therefore need a fresh link next time.

All paired browsers for this resident can be revoked together:

```sh
ziggy web revoke squarey
```

Revocation closes an active browser connection on its next request or event. Every browser then
needs a fresh pairing link.

## Profiles, residents, and ports

One resident hosts a shared gateway. Every Profile registered with that resident is selectable in
the web client, so selecting another Profile does not require another port or pairing link. Browser
authorization applies to the gateway as a whole; it is not a per-Profile access list.

Run separate residents only when you need separate owner processes or separate browser origins.
Each resident needs a distinct local port and, for remote access, a distinct public origin. Pairing
and revocation are scoped to the owner Profile's gateway. Separate origins create separate browser
credentials, but they do not isolate Profiles while the residents expose the same registered
Profile directory.

## Updating the packaged guidance

This guide also ships inside the required `ziggy-operations` package. Updating the Ziggy binary
does not overwrite an installed Profile-owned package. For an older untracked installation, close
active Profile sessions, stop the resident, then deliberately adopt the package from the updated
executable:

```sh
ziggy extensions update squarey ziggy-operations --adopt
```

Use `--adopt` only for the initial takeover of an untracked package. Tracked packages use the normal
update command. See [Updating bundled extensions](extension-updates.md) for fencing, backup, and
local-change behavior.

## Troubleshooting

If `ziggy web pair squarey` prints `http://127.0.0.1:0`, no stable web configuration exists. This is
a known 0.2.6 CLI limitation: configure a nonzero port, restart the resident, then pair again.

If the resident fails after configuration, check whether another process or resident already owns
the port:

```sh
ziggy serve status squarey
ziggy serve logs squarey
```

If local access works but the remote URL does not, confirm that the Tailscale mapping targets the
same loopback port and that `--public-url` matches the browser origin, including its HTTPS port.

For service installation, lifecycle, logs, and restart behavior, see
[Supervise `ziggy serve`](serve.md).
