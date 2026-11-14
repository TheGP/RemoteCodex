# Coding agent providers

Codex and ZCode have registered adapters. Their installed runtimes and credentials stay outside the application bundle. ZCode is disabled by default; Claude Code remains a researched integration target.

## Current boundary

`providers.cjs` owns registration and `AgentConnection`. `transport.cjs` is the Codex adapter; `zcode.cjs` translates the ZCode V4 protocol into the same internal contract. Executable discovery, launch, initialization, and native JSON framing stay inside each adapter. `agent-pool.cjs` holds concurrent connections and routes operations by conversation/model owner. Scheduling uses the pool; images, diagnostics, and wake locks use the owning connection. The renderer receives the sandboxed `window.agent` bridge and provider metadata, never an adapter or process handle.

A registered descriptor supplies `id`, `name`, supported `methods`, `options(value)` and `create()`. Registration is trusted application code, not arbitrary paths loaded from settings. Options must contain validated, credential-free launch settings: they are saved and exposed to the renderer, so authentication remains engine-owned. Unknown IDs fail before the current connection is disconnected. Adding a provider means implementing its adapter and registering the descriptor; it does not require another renderer or a second app.

Adapters provide:

- `connect(options)`, `disconnect()`, `ready`.
- `call(method, params, timeout)`, `respond(nativeId, result)`, `rejectRequest(nativeId)`.
- EventEmitter events: `notification`, `diagnostic`, `rpc`, `disconnected`.

`methods` uses the existing application's thread/turn/item vocabulary, originally derived from Codex. This is an internal application contract, not a requirement that another engine speak Codex on the wire. Translate native commands, messages, tools, timestamps, approvals, errors, and lifecycle events inside the adapter. A successful send acknowledgment is not a completed turn. Preserve stable item IDs and history sequence ordering; avoid terminal-output scraping.

`rpc` events have `phase: started|finished`, `requestId`, `method`, `threadId`, and a normalized `result` on success. Consumers use them for scheduling diagnostics and sleep prevention. Adapters must reject pending calls on disconnect, clean up only their own processes, and reconnect through the host. A driver `session` is an opaque connection identity; application services must not inspect native child processes.

The host scopes interaction IDs per connection and rejects late results/events after replacement. Notifications carry a physical `machine` identity and a `provider`; all active providers share the sidebar and timeline machinery. Non-Codex thread, turn, item, project, model, and request IDs are qualified as `agent:<provider>:<kind>:<encoded-native-id>`, preventing native ID collisions. Codex IDs stay unchanged. Cross-provider model/thread/project combinations are rejected before dispatch. Questions and answers route to the owning connection, including after switching chats. Renderer RPC retains its fixed allowlist; internal file reads remain inaccessible as arbitrary renderer RPC. Unsupported capabilities fail explicitly; optional projects, usage, skills, and Plan catalogs are skipped when absent. Extend feature-specific UI guards when adding an adapter with fewer capabilities.

Codex keeps its old `access:local` and SSH storage keys, including existing pins and drafts. All agents share this physical machine scope; qualified IDs separate their pins, drafts, unread state, queues, and scheduled tasks. A chat keeps its agent: the model menu disables other agents for existing chats, and shows every connected agent for new chats. Account usage and skills follow the selected chat’s agent. A provider failure clears only its running state and pauses only its queues; other agents continue. A saved `codexPath` migrates to the common `executablePath` field. Old settings without a provider remain Codex. Settings configure the physical local/SSH machine, not an exclusive active agent; optional `providerOptions[id].executablePath` supplies another registered agent’s executable. Adding adapters must not reconnect the pool when models change.

Shared list calls keep healthy results and return provider-specific `errors`; cached projects and conversations remain visible for failed providers. If every provider fails, the request still rejects. Model and mode catalogs retain cached entries for failed or disconnected providers; a missing Plan preset blocks sending instead of running a normal turn. Recovery retries only enabled disconnected agents every 15 seconds while another connection is healthy, and on a Connect request with unchanged settings. It preserves the pool session, healthy drivers, pending answers, running chats, queues, and typed drafts; attempts already in progress are left alone. `providers/updated` refreshes metadata and catalogs after recovery and clears its own disconnect banner without dismissing newer errors.

`providerOptions[id].enabled` saves each agent's preference. Settings list the registered adapters; ZCode defaults to disabled. `providerOptions[id].executablePath` stores an optional absolute runtime path. Provider changes preserve the pool session and unrelated drivers, block only affected agents' running tasks, and allow every agent to be disabled. Machine changes require all tasks to finish. Same-machine settings are written before applying changes so a failed write leaves running agents untouched. Edit & resend validates the model, provider and collaboration settings both before acquiring a writer lock and immediately before reverting history.

## ZCode adapter — 2026-11-13

The local CLI is 0.17.1, built from [upstream commit fec9759](https://github.com/zai-org/ZCode/tree/fec975905a2abd4c07e35c40d51fa097a2258ec9), and exposes `app-server`. The adapter uses its V4 stdio NDJSON protocol, conversation topics, authoritative snapshots and ordered deltas. The native runtime owns provider configuration and authentication; credentials never enter the renderer or saved connection settings.

The adapter uses `desktop-continuous` delivery, tracks sequence/log epochs, and recovers gaps from a snapshot. Intents go through `v4/command`; command acknowledgment does not imply a completed turn. Sessions map to threads, projected rows to items, phases to turn lifecycle, and interactions to question/approval requests. Only implemented capabilities are advertised; unsupported history editing, cloning, archive and Plan operations stay unavailable.

ZCode's `permissionOptions` advertises its native ask-before-changes and full-access modes. The model menu hides unsupported access choices when selecting ZCode; restoring an older restricted draft keeps its original setting until the user explicitly changes it.

ZCode owns its accepted command queue. Integrate its queue projection and commands rather than duplicating accepted work in `QueueStore`. Drafts and delayed schedules remain app-owned until submission. Workspace identity also scopes runtimes and subscriptions; one global process assumption is insufficient. Provider configuration is revisioned, and credentials should stay outside snapshots and renderer state.

## Claude Code research — 2026-11-12

The [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) exposes Claude Code's agent loop. Its [streaming input mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) is intended for persistent interactive sessions, interruptions, and permissions; it is a better candidate than parsing a terminal interface. Keep the SDK in an adapter-owned worker so disconnect and abort do not affect unrelated sessions.

Map SDK sessions and message/tool IDs into the application contract; implement permission and user-question callbacks through pending interactions. Keep context and cost accounting distinct from account quota and reset information. Do not assume Codex permission modes, skills, review, or history-revert operations map directly. Advertise only verified capabilities, and design authentication against the SDK's current documented rules rather than assuming subscription credentials are interchangeable.

The [CLI reference](https://code.claude.com/docs/en/cli-reference) also documents machine-readable output and explicit session resume. If the SDK is unsuitable, evaluate that documented subprocess interface with the same lifecycle and permission tests. No Claude SDK installation, login, or inference was performed for this research.

## Adapter acceptance checks

Before enabling another agent, verify streaming and final replies, history/reopen, questions and approvals, interruption, failed sends, queue/schedule ownership, images and diffs, unsupported features, and reconnect races. Reuse identical native IDs in different providers during tests. Confirm pins, drafts, unread markers, usage caches, and answers stay isolated. Verify native authentication and runtime compatibility separately; passing a fake adapter test does not certify another engine.
