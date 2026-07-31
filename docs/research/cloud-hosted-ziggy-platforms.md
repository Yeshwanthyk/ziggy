# Cloud-hosted Ziggy: platform facts and a narrow recommendation

Research date: 2026-07-31. Sources are first-party product documentation and
source repositories. This note evaluates hosting the existing Bun/Pi runtime,
where a Profile is a normal directory and Pi expects ordinary filesystem
semantics; it does not propose replacing Pi with another agent framework.

## Recommendation

Use Fly Machines plus one Fly Volume for the first hosted proof. It is the
shortest path to the contract Ziggy already has: mount the volume at the Profile
path, run Bun and Pi unchanged, and stop or suspend the Machine when the gateway
is genuinely idle. The volume is a normal POSIX directory and survives Machine
deploys and restarts. This is a proof architecture, not yet a highly available
one: a volume is local to one server in one region, attaches to one Machine, and
is not replicated automatically. Ziggy must add backups before treating it as
the only copy of a Profile. [Fly Volumes overview](https://fly.io/docs/volumes/overview/)

Treat Cloudflare Containers plus Durable Objects and R2 as the edge-native
target. Cloudflare's local container disk is currently ephemeral: after sleep,
the next instance starts from the image again. Therefore a Profile cannot live
authoritatively on that disk. A session Durable Object should own routing,
lifecycle, small authoritative metadata, wake scheduling, and the current
Profile snapshot/version; R2 should hold immutable Profile snapshots and larger
artifacts. Container start materializes the selected snapshot into a fresh
directory, and quiescent checkpoints publish a new snapshot before the
container is allowed to sleep. This is application-level materialization and
snapshotting; Cloudflare's container-disk snapshots are still documented as
"coming soon." [Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)

## Cloudflare platform facts

`getContainer(binding, id)` routes a stable ID through a Durable Object to one
container instance. The `Container` base class itself extends `DurableObject`,
so the object can use `ctx.storage` for data that survives container restarts.
`sleepAfter` controls how long an inactive instance stays up and defaults to ten
minutes; expiry normally stops the container. All container disk is ephemeral,
and Cloudflare documents R2-backed FUSE as an available persistence mechanism
but warns not to expect native-SSD performance. [Container class](https://developers.cloudflare.com/containers/container-class/),
[getting started and routing](https://developers.cloudflare.com/containers/get-started/),
[container lifecycle and disk](https://developers.cloudflare.com/containers/platform-details/architecture/)

Durable Objects combine single-object compute with transactional, strongly
consistent, serializable storage. That makes a Profile/session ID a useful
coordination key, but DO storage is not the Profile's POSIX filesystem. Keep
lease/checkpoint state, snapshot digests, delivery cursors, and alarm metadata
there; materialize files into the container for Pi. [Durable Objects overview](https://developers.cloudflare.com/durable-objects/)

A Durable Object can set one alarm at a time. Alarm delivery is at least once;
failed handlers are retried with exponential backoff. One alarm can still drive
many scheduled items by storing a queue and rescheduling the next due item.
Automation handlers therefore need idempotency keys and persisted completion
state. [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)

The hibernation WebSocket API keeps clients connected while evicting the
Durable Object from memory and stops duration billing while hibernated. On the
next message the object is reconstructed, so all durable attachment/session
state must be recoverable from WebSocket attachments or DO storage. This is a
good attachment transport, not process persistence: the Pi process still lives
in the container and its Profile still needs checkpointing. [Durable Object
WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

R2 is S3-compatible, strongly consistent object storage. It is appropriate for
content-addressed Profile archives, session exports, and large immutable
artifacts. It is not a drop-in POSIX volume; direct Worker/S3 operations should
be the durability path, with FUSE used only when its semantics and performance
are explicitly accepted. [How R2 works](https://developers.cloudflare.com/r2/how-r2-works/),
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)

## Vercel: Eve and Sandbox

[Eve](https://github.com/vercel/eve) is useful evidence for the filesystem-first
shape, not a substrate Ziggy should adopt. Its authored agent is a directory of
instructions, tools, skills, channels, and schedules. At runtime, each turn is
a durable Workflow SDK workflow; the trusted app runtime owns model calls,
tools, connections, and checkpoints, while a separate per-session sandbox owns
`/workspace` and processes. The workflow can park or restart independently of
sandbox compute. On Vercel, the workflow adapter becomes Vercel Workflow and
the sandbox backend becomes Vercel Sandbox without changing the authored agent
directory. [Eve execution model](https://github.com/vercel/eve/blob/main/docs/concepts/execution-model-and-durability.mdx),
[Eve sandbox model](https://github.com/vercel/eve/blob/main/docs/sandbox.mdx),
[Vercel's launch description](https://vercel.com/blog/introducing-eve)

That separation is the relevant pattern for hosted Ziggy: a durable control
plane owns resumable orchestration and a sandbox owns filesystem/process work.
The difference is that Ziggy's Profile is already the product's durable state,
so a hosted implementation must preserve the Profile itself rather than move
authority into a second framework's conversation format.

Vercel Sandbox now separates run duration from persistence. `timeout` governs
one VM session: the default is five minutes, the current maximum is 45 minutes
on Hobby and 24 hours on Pro or Enterprise. Persistent sandboxes are the
default; stopping one snapshots its filesystem and a later resume boots a new
session from that snapshot. Snapshots expire 30 days after last use by default.
Vercel recommends Drives when data must outlive a sandbox or be shared among
sandboxes. This can host a Profile, but the lifecycle remains snapshot-based
rather than a continuously mounted volume. [Vercel Sandbox duration and
persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence),
[Sandbox snapshots](https://vercel.com/docs/vercel-sandbox/concepts/snapshots)

## Astro Flue

[Flue](https://github.com/withastro/flue) is another architecture reference,
not a Pi host. It can build for Node or Cloudflare; its default virtual sandbox
is fast but ephemeral, while provider-backed sandbox adapters map a remote
filesystem and shell into a common `SandboxFactory`. The application, not Flue,
owns sandbox creation, reuse, retention, and deletion. Reusing a provider
sandbox keyed by agent-instance ID is how a conversation can regain the same
durable workspace. [Flue sandbox guide](https://flueframework.com/docs/guide/sandboxes/),
[sandbox adapter API](https://flueframework.com/docs/api/sandbox-api/)

Flue deliberately separates conversation persistence from workspace
persistence. On Node, a conventional `db.ts` selects SQLite or an external
`PersistenceAdapter`; on Cloudflare, generated Durable Objects use SQLite.
Neither database path persists sandbox files. Its Cloudflare deployment target
can combine Durable Object-backed conversations with a Cloudflare remote
sandbox, while other providers such as Vercel Sandbox remain thin adapters.
[Flue database and persistence](https://flueframework.com/docs/guide/database/),
[Cloudflare deployment](https://flueframework.com/docs/ecosystem/deploy/cloudflare/),
[Vercel Sandbox adapter](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)

## Fly platform facts

Fly Proxy can start stopped Machines when a request arrives and stop or suspend
them after several idle minutes. `auto_stop_machines`, `auto_start_machines`,
and `min_machines_running` configure that behavior; stopped or suspended
Machines do not incur CPU/RAM charges. Autostop never creates or destroys
Machines. A detached background job is a sharp edge: once an HTTP response
closes, the proxy can see no active connection and stop the Machine while the
job is still running. Ziggy should therefore keep task ownership in the gateway
and stop only after Pi is quiescent, rather than equating client disconnect with
cancellation. [Fly autostop/autostart](https://fly.io/docs/launch/autostop-autostart/),
[Machines API lifecycle guidance](https://fly.io/docs/machines/guides-examples/managing-machines-with-the-api/)

The Machine root filesystem is ephemeral. A Fly Volume is local persistent
NVMe mounted as a regular directory, which is why it is the fastest faithful
Profile proof. Its limits are also explicit: one server and region, one Machine
attachment, no automatic replication, and snapshots are not a substitute for
an application backup. [Fly Machines overview](https://fly.io/docs/machines/overview/),
[Fly Volumes overview](https://fly.io/docs/volumes/overview/)

## Security boundary for Profile resources

Hosted Profile synchronization must distinguish approved skills from
executable extensions.

An approved skill may be copied into a Profile only from a signed manifest or
an allowlisted content digest. Verify every `SKILL.md` and supporting file
against that manifest before materialization, retain the digest in the Profile
snapshot metadata, and reject mutation or path escape. This is a provenance
gate, not a claim that skill text is harmless: instructions can still persuade
the model to invoke powerful tools, so sandbox egress and tool authority remain
independently constrained.

Pi extensions are executable TypeScript loaded into the runtime with host
permissions. Do not admit them through the same Profile file-sync path. A cloud
deployment should load executable extensions only from the reviewed, pinned
container image (or a separately signed code bundle verified before process
startup), never from R2 objects that the running agent can modify. A package
that contains both skills and extension entrypoints inherits the executable
boundary and must be deployed as code. The local semantic distinction is
documented in [Pi skills, extensions, and packages](./pi-skills-extensions-semantics.md).
