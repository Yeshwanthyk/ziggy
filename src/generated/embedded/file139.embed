---
name: dev-browser
description: Automate a website with sandboxed JavaScript in a named persistent dev-browser profile, or inspect and stop the dev-browser daemon.
---

# Dev Browser

Use `dev_browser` when browser work needs a reusable signed-in browser profile and no narrower API
or connector fits. Prefer a purpose-built API for data access and mutations when one exists.

For `execute`, choose a short lowercase `profile` slug that represents the site or account context.
The same slug inside the same Ziggy Profile maps back to the same dev-browser browser profile.
Scripts run in dev-browser's QuickJS sandbox and arrive through stdin; they are not shell commands.
Use `connect: true` only to auto-discover an already-running Chrome. Remote CDP URLs are not
supported by this extension.

dev-browser stores browser profiles in its persistent global store, outside the Ziggy Profile.
Idle cleanup closes only daemon-launched browsers and preserves their profile, cookies, and login
state. It never reaps externally connected browsers. `stop` is global: after explicit confirmation,
it stops the daemon and all managed browser connections but does not delete persistent profile
directories.

Treat browser automation as ephemeral execution data. Never put executable scripts, cookies,
authorization headers, tokens, passwords, or other secrets into saved workflows. Saved workflows
should contain only the safe intent and inputs needed to recreate a step at run time.
