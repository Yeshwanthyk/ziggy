# Drive a Profile from Buzz over ACP

This guide wires one Ziggy Profile (or Profile specialist) into Buzz Desktop as an ACP agent, and
records the ACP integration notes that make the wiring behave.

Buzz Desktop spawns ACP-speaking subprocesses ("harnesses") and bridges channel events to them. Ziggy
already speaks ACP v1 over stdio (`ziggy acp <name|path> [--shared]`), so Buzz only needs to know the
command.

## What the bridge provides

- A Buzz agent row maps 1:1 to a `ziggy acp <profile>` process. Buzz owns the conversation shell
  (channels, mentions, presence); Ziggy owns the reasoning, Profile identity, memory, and sessions.
- Sessions land under `<profile>/sessions/acp/<session-id>/`. Default sessions use owner memory;
  `--shared` uses `group:acp-<sessionId>` so shared/Zed/Buzz-style harnesses never receive owner
  memory.
- Model selection is advertised through the Buzz/unstable `SessionModelState` extension: ziggy
  reports `models.availableModels` (auth-configured providers only) and `currentModelId` in the
  `session/new` response, and accepts a `session/set_model` request to pin a session model.
- Profile specialists are reachable with `--agent <agent-id>`; see below.

## Setup in Buzz (verified 2026-08-19, Buzz 0.5.x)

1. **Install or build ziggy** so the binary on `PATH` (or an absolute path) has the `acp` command:
   ```sh
   curl -fsSL https://github.com/Yeshwanthyk/ziggy/releases/latest/download/install.sh | sh
   ziggy version   # needs >= 0.2.3 for SessionModelState announce; >= 0.2.4 for --agent
   ```
2. **Register the runtime**: Buzz → Settings → Agents → "Add runtimes" → **Custom harness**.
   - Name: `Ziggy (squarey)` (any label)
   - Command: `/Users/yesh/.local/bin/ziggy` (absolute path; Buzz's launch environment has a minimal
     `PATH` and may not see `~/.local/bin`)
   - No custom-harness file per specialist is needed — see "Specialists" below.
3. **Create an agent**: Agents → "New agent" → name + instructions (system prompt), AI configuration
   → Customize for this agent → Agent harness = `Ziggy (squarey)`, Model = any announced model
   (ziggy's profile default applies if left at "Use agent defaults"). Start the agent.
   - Buzz writes the row to `~/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json`
     with `agent_command` set to the custom harness id and the picked model under `model`.
4. **Open a channel or DM with the agent** and @-mention it. Presence is online once the harness
   spawns `ziggy acp <profile>`; Buzz logs show `presence set to online` and the session appears
   under `<profile>/sessions/acp/`.

## Specialists (`--agent`)

`ziggy acp <name|path> [--shared] [--agent <agent-id>]` opens the session on a Profile specialist
(`agents/<agent-id>.md`) instead of the default persona. Buzz models this with **one harness, one
command, per-agent args** — no extra custom-harness files:

| Buzz agent row                        | `agent_command`     | `agent_args`              |
| ------------------------------------- | ------------------- | ------------------------- |
| `Ziggy` (default persona)             | `ziggy-squarey`     | `[]`                      |
| `Ziggy · Ada` (coding specialist)     | `ziggy-squarey`     | `["--agent", "ada"]`      |
| `Ziggy · Writer` (prose specialist)   | `ziggy-squarey`     | `["--agent", "writer"]`   |

Each row is created the same way as step 3; only the args differ. Buzz appends `agent_args` to the
harness command when spawning (the same pattern codex-acp and claude-agent-acp use for per-agent
flags). Unknown specialist ids fail at `session/new` with an ACP error rather than falling back to
the default persona.

## Operational notes

- **Models come from auth.json ∩ models-store.json.** `session/new` advertises only providers with
  complete auth configuration (`ModelRuntime.getAvailable()`). Link a provider with `ziggy auth`.
- **OpenCode "opencode" is an LLM provider, not an ACP agent.** Pi's `opencode-go` provider id and
  Buzz's OpenCode harness are unrelated; do not conflate them in prompts or config.
- **Buzz re-materializes built-in personas.** Fizz/Honey/Pollen reappear after local deletion because
  they are built-in personas plus relay-published identities. Removing those for good means archiving
  their relay identities (`buzz agents archive <pubkey>`); "removing" them from
  `managed-agents.json` while Buzz runs is reconciled away.
- **Harness files are only for the command template.** `custom_harnesses/<id>.json` holds
  `{id, label, command, args, env, ...}`. Prefer per-agent `agent_args` over chaining more harness
  files when only the launch arguments differ.
- **Path resolution.** Use an absolute binary path in the Custom harness command; Buzz's launch
  environment PATH is minimal.
- **ACP probes can look like failures.** Buzz may report "no models" until the binary answers
  `session/new` with `models`; ziggy answers `initialize` with `agentCapabilities: {}` by design
  (prompt-only face), which is sufficient. See `docs/research/acp-server-surface.md` for the exact
  advertised surface.

## Verification

- `ziggy acp` prints `usage: ziggy acp <name|path> [--shared] [--agent <agent-id>]`.
- A manual ACP handshake (`initialize` then `session/new`) returns `models.availableModels` with
  `provider/model` ids and `currentModelId` matching the profile default.
- In Buzz: agent profile shows "running", harness log shows `presence set to online`, and a mention
  produces a session under `<profile>/sessions/acp/`.
