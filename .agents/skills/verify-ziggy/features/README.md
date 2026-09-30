# Ziggy features

The verification index. Launch, doctor, drive, evidence and cleanup rules are in
[`../SKILL.md`](../SKILL.md); every recipe assumes a scratch Profile from the sandbox or the harness.

Proof status: **green** = a passing proof in `test/e2e/`; **red** = a `test.failing` proof that
documents a known bug and turns green when the work order fixes it; **uncovered** = no proof yet.

| Feature | Outcome the user sees | Proof |
| --- | --- | --- |
| [Run](run.md) | `ziggy run` answers from the Profile's SOUL and model | green — `cli.test.ts` |
| [Profiles](profiles.md) | `init` never overwrites SOUL; `profiles` is read-only | green — `cli.test.ts` |
| [Models](models.md) | `models set` changes the model the next turn uses | green — `cli.test.ts` |
| [Sessions](sessions.md) | list/show are read-only; `run --session` continues one file | green — `cli.test.ts` |
| [Web sessions](web-sessions.md) | the UI streams a turn, survives reconnect, shares one main | green — `resident.test.ts` |
| [Single writer](single-writer.md) | a live session refuses a second writer by name | green — `resident.test.ts` |
| [Agents](agents.md) | `agent_run` makes one linked child with only its declared tools | green / red — `agents.test.ts` |
| [Memory](memory.md) | memory persists, is visible next turn, and respects scope and cap | green — `memory.test.ts` |
| [Automations](automations.md) | an automation's result reaches its target conversation once | green — `automations.test.ts` |
| [ACP](acp.md) | an editor prompts over ACP and gets streamed answers | green / red — `acp.test.ts` |

Uncovered, recorded rather than implied: web `/new` then `run -c`; resume/new/fork ordering;
channel (Telegram/Discord) watch-only; a live automation delivery into a session the UI
switched away from; Profile extensions; `agent_discuss`; the web UI in a real
browser (drive by hand with `web pair`, see `../SKILL.md`).
