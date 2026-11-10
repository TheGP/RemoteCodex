# Remote Codex

A desktop GUI for running Codex locally or on your server over SSH. Conversations are on the left, messages and tool activity on the right. Consecutive tool calls and thinking steps collapse into one live activity line; click it to expand or collapse the full log. Supports macOS and Windows.

## Installed on this Mac

- Source: `/Users/EugeneBos/Websites/remote-codex`
- Application: `/Users/EugeneBos/Applications/Remote Codex.app`
- Server: `root@warmer`

Open **Remote Codex** from Applications or Spotlight. It reconnects to your last machine automatically. Click the machine card at bottom left, choose **This machine · Local** or **Remote machine · SSH**, then **Save & connect**. Existing SSH settings stay remote; fresh installations start locally. Local and remote workspace settings are saved separately.

**Connect** appears only while disconnected. Connection changes are blocked while any chat is working; connecting again with the same settings reuses the running Codex process. Reading chat history never restarts that process.

Choose a theme in **Settings → Theme**: System, Light, Dark, Purple, Claude Code, Nord, or Midnight. Themes change colors immediately, keep the same fonts, and persist after restarting. Click **Done** to close settings. **Save & connect** appears only when connection settings change or Codex is disconnected.

**Settings → Sound on completion** is enabled by default. A quiet half-second chime plays when a chat finishes, including background chats. Intermediate queued turns, failures, interruptions, and duplicate events stay silent; nearby completions share one chime. Use the **Volume** slider (0–100%, default 50%) and **Preview** to choose a comfortable level, or turn sound off. The volume updates live and survives restarting without reconnecting chats; Preview shows playback failures, and playback diagnostics use the existing bounded log.

The compact usage bars beside the access selector show conversation context remaining and the tightest reported account limit. Click the graphs to see reset dates and times, plus available early resets and their expiry dates when Codex reports them. Percentages stay in the graphs. Times use your local timezone. Opening the popup refreshes the data; click outside or press Escape to close. Quotas also refresh automatically once a minute while the app is visible. Context appears when Codex reports token usage for the conversation; unavailable data shows **—**. Each connected machine uses its own Codex account and usage data.

Right-click a project → **Expand conversations** to show 50 conversations inline in the sidebar, with pagination below. **Show fewer conversations** returns to the five-chat preview. In **Project settings…**, enable **Expand this project when the app starts** to expand it automatically and use its folder for new conversations. Other projects and your current conversation remain available. Themes and startup choices are saved in the app's local `preferences.json`.

Drag a conversation above or below another conversation in the same project to reorder it. The insertion line shows where it will land. Custom order and its cutoff for new conversations are saved by this app per project and machine and survive restarts. Existing orders acquire a cutoff once when loaded. New conversations stay above the saved order when older chats receive updates; pagination, pin changes, and refreshes keep that cutoff unchanged. Pinned chats stay above unpinned chats; each group can be reordered separately.

Click **New conversation → Browse** or **Choose project** to select a folder on the connected machine. Any folder can be a project. Selecting a folder from an existing conversation starts a new conversation there; existing conversations keep their original folder. Selecting a conversation reads its history without taking a writer lock. Sending a message acquires the writer only when needed. If another Codex process owns that conversation, a compact notice keeps the draft intact and offers **Retry**; closing a tab in another app may leave its server running and retaining the lock. Stop or close that owning session/server before retrying. Use the model, reasoning, and access controls under the message box. **Stop** interrupts the current turn.

Saved projects appear as collapsible sidebar groups, with five recent conversations and **Load more conversations** below each group. Use **+** beside a project to start a chat in its saved folder. Right-click a project or use its **⋯** menu to rename it or move it up/down. Drag a project heading above or below another project to reorder them; names and order are saved in Codex. **New conversation** continues using the selected project. Drag a conversation onto a project group or back onto **Other conversations** to move it, including into collapsed projects. You can also right-click and choose **Move to project…**, or **No project** to return it to other conversations. Project definitions and conversation membership use Codex's native project API and persist on the connected machine; local and SSH projects stay separate.

Hover a conversation and click its pin icon to move it to the top of its project, or above other conversations when it has no project. Click the pin again to unpin. Pins persist after restarting the app, stay visible beyond the first page of history, and are separate for local Codex and each SSH host/port. They are saved by this client and do not sync to other Codex apps.

Pinned conversation titles use a muted yellow color. Queued messages have a six-dot drag handle on the left: drag above or below another queued message to change the sending order. The order is saved across restarts; automatic sending waits while dragging and saving.

Unsent composer drafts save as you type, separately for each conversation, new-chat project/folder, and machine. Text, attachments, model, reasoning, access, Plan mode, and send-time choice restore after restarting; the last unfinished chat or editor reopens without sending anything. Queue-editor and earlier-message editor text also survive restarting; Cancel explicitly discards that editor draft. Drafts clear after a successful send, queue save, or scheduled save; an unconfirmed send keeps its draft. Draft data is stored privately under the app data directory’s `drafts/` folder, with image files saved separately from text so typing does not rewrite them.

In text-editing dialogs, including queued messages and **Edit & resend**, **Enter** submits the form and **Shift+Enter** adds a new line. A failed save keeps the editor open.

Conversations show a spinner while Codex is working, a green dot when an unseen reply finishes, and a red dot if an unseen turn fails. Completion dots and manual unread markers are saved in `preferences.json` separately for each machine and survive app restarts and updates. Existing manual unread markers migrate from browser storage automatically. Replies stay read while the app is focused and the latest messages are visible. Opening the conversation, returning to the app, or scrolling to the latest reply clears its marker. These indicators work for pinned and recent conversations.

Click a conversation in the sidebar, then press **U** to mark it unread. Plain **U** works while that sidebar row is focused and does not intercept typing in the composer, search, or editors. You can also right-click → **Mark as unread**, or press **⌘⇧U** on Mac / **Ctrl+Shift+U** on Windows for the selected chat. Unread chats have bold titles and a blue dot; working chats keep their spinner. Unread markers are saved by this app separately for each machine and clear when you reopen the conversation.

The compact sidebar shows one title line, with **Load more conversations** at the bottom of the scrolling list. Chats without a title immediately show the beginning of their first prompt, then replace it with a title generated using OpenRouter `openai/gpt-4.1-nano`; the generated title is checked against the request language before being saved on the connected Codex machine. A mismatched or uncertain language keeps the original prompt preview. Right-click a conversation and choose **Rename conversation** to set your own title. Manual titles are preserved. A failed title does not block other chats: it retries twice, one minute apart, and later sidebar refreshes can retry it again. Archiving cancels pending title retries; recovery clears only the matching title error. Title outcomes are logged without prompt or title text. The first 4,000 characters of the initial prompt are sent to OpenRouter for title generation; images are not sent to the title service. The key stays in the main process, using `OPENROUTER_API_KEY` or the encrypted `title-key.enc` in the app settings folder. This Mac has an encrypted key configured; other installations need their own key.

Right-click a conversation and choose **Clone conversation** to copy its history into a separate chat. Hover an earlier user prompt and choose **Edit & resend** to replace that message and later replies in the current conversation, keeping its attachments, title, project, and pin. File changes are not undone. The task must be stopped before editing, and existing queued messages stay paused after history changes. A failed resend keeps the edited draft in this chat’s paused queue. New chats use paginated history; older legacy or ephemeral chats cannot be edited in place and never silently create a copy. Messages added with Steer belong to their original turn; edit that turn’s initial prompt to rewind from its beginning.

Right-click a conversation and choose **Archive conversation** to hide it using Codex's native archive and remove its pin and unread marker. Archiving the current chat opens a new conversation. Running tasks and queued messages must finish or be removed first. Archived history stays on the connected machine; files are unchanged.

While Codex is running, **Enter** or **Send** with **Now** selected saves a follow-up to send when the turn finishes. Queued messages appear above the composer; remove one with **×** or use **Steer** to send it into the current turn. Click the queued text or **Edit** to change it; **Steer** appears only on queued messages and sends that message into the running turn. An open queue editor pauses automatic sending until saved or closed. Queues, edits, images, and skill attachments are saved on this computer and survive app restarts. They stay separate for each conversation and machine. Restored queues, failed or interrupted turns, reconnects, and lost connections leave messages paused as **Waiting**; opening a chat does not send them. Use **Retry** to resume sending, or **Steer** to explicitly send a queued message into an active turn. Healthy queues still send automatically after a successful turn. Failed sends stay queued for review and retry. Conversations open at the end without a scrolling animation.

Choose **Now**, **1–24 hours**, or **1–7 days** immediately left of **Send** to send a message later. While Codex is working, the main button shows **Stop** for an empty prompt and **Send** when text or an attachment is present; **Now** keeps the normal follow-up queue behavior. Scheduled messages keep their text, images, skills, model, mode, and access settings on disk, separately for each local or SSH machine. The time resets to **Now** after scheduling; switching chats restores the saved draft’s send time, or **Now** when there is no draft. A clock beside the conversation shows saved scheduled work; the conversation shows its send time and a cancel button. Cancel pending schedules before archiving.

The app checks due messages every 15 seconds while connected and after wake, waits for the conversation and its existing queue to become idle, and picks up overdue work after restart. It does not wake the computer. If delivery is unconfirmed, it does not automatically resend: check chat history before scheduling again. The scheduler MCP implementation is retained but disabled: it is not started or registered with Codex, and agents cannot see its tools. Scheduling uses the existing app process, with no extra service or package.

Send and queue diagnostics are saved under the app data directory in `logs/diagnostics.log` and `logs/diagnostics.1.log` (**10 MB combined maximum**, rotating automatically). On macOS this is `~/Library/Application Support/Remote Codex/logs/`. Logs record queue states, pause reasons, turn IDs, RPC results, first-output timing, activity, a snapshot after 60 seconds without progress, recovery, sleep/wake, and browser online/offline events. Codex stderr warnings and errors record only their severity, module, classified cause, and available thread/turn IDs (at most 20 per 30 seconds); raw stderr text is omitted. Message bodies, attachments, and tool arguments are omitted, and common credentials in existing error messages are redacted. Quiet-turn logging never stops or retries a task. Logging starts after launching the updated app.

Command and tool rows show one line by default. Click to expand the full command and output. Scrollbars use a thin, muted style. The app icon uses a monochrome folded R on a dark rounded-square tile.

Type `/` in the composer to search commands and installed skills on the connected machine. Use ↑/↓ to select, Enter or Tab to choose, and Esc to dismiss. Commands include `/new`, `/model`, `/reasoning`, `/permissions`, `/plan`, `/review`, `/compact`, `/skills`, `/init`, `/project`, `/rename`, `/status`, and `/mcp`. Selecting a skill inserts its `$name` and attaches its skill path when sent. `/plan` toggles Plan mode for future messages; `/plan off` returns to normal mode. `/review` applies the selected access settings before reviewing uncommitted changes; if applying settings fails, the review does not start. `/compact` compacts conversation context.

Local mode uses the installed Codex, its existing login/configuration, and its conversation history. It prefers the current managed Codex runtime used by the desktop app, then checks PATH, common install paths, and nvm installations, including when launched from Finder. Set **Codex executable** to an absolute path to override discovery. An npm-installed Codex also needs its Node.js runtime. No separate API key is needed when Codex is already signed in.

SSH mode uses the server's Codex login and configuration. SSH credentials are handled by the system SSH client; the app saves only host, port, key *path*, and default workspace. The server must already be trusted in `~/.ssh/known_hosts` (`ssh root@warmer` once if setting up another computer). Encrypted keys work through your SSH agent or macOS Keychain. The app never copies private keys.

Default access is **Workspace access** with approval prompts. **Read only** prevents edits. **Full local access** or **Full server access** gives Codex the connected account's filesystem access and runs commands without approval prompts. The access selection is saved separately for each machine. Commands and conversation history stay on the selected machine. Closing the app or switching machines disconnects its app-server process; keep the app connected while a task runs. Reconnect after an interruption, then reopen the conversation. Requests that time out may already have reached Codex; check history before resending.

Drag images onto the chat, paste an image, or click **＋** to attach images. Review or remove previews before sending. Supports PNG, JPEG, WebP, and GIF (up to 10 images, 20 MB total); image-only messages work too. Images are sent over the active local/SSH connection and saved in Codex conversation history. Reopening the selected chat keeps its image draft. The composer briefly prevents editing while a send is being accepted, then restores typing without losing focus.

Screenshots in assistant Markdown, image-view tools, and image tool results appear inside the conversation. Click an image to enlarge it. File paths resolve on the connected machine, including workspace-relative paths; file previews support PNG, JPEG, WebP, and GIF up to 20 MB. Missing files show an explanation. External image URLs and SVG are not loaded.

Click web links in replies to open them in your default browser, including local development URLs such as `http://localhost:5173`. Middle-click and Cmd/Ctrl-click also open the browser. Right-click a web, file, or folder link and choose **Copy link** to copy its URL or full path, including any line and column. Relative paths use the original conversation’s folder. Chat stays in the app; unsupported link types and browser launch failures show an explanation.

File links open in the app selected under **Settings → Open file links with**: **VS Code** (default), **GitFerry**, **Antigravity IDE**, or **Show in Finder/file manager**. Absolute paths, workspace-relative paths, and `file://` links support `:line:column` and `#Lline` references, including bare filename targets such as `submitAppeal.ts:77`. Relative targets use the conversation’s folder. Changes save immediately without reconnecting chats. Local files must exist; SSH paths always stay remote. VS Code needs Remote SSH for remote links. The editor uses system SSH configuration; its resolved host port must match the chat’s port. Custom ports work through an SSH host alias configured with that port. Antigravity requires the separate Antigravity IDE, and file-manager opening is local only.

GitFerry opens the working file in its normal editable side editor at the requested line and column using its registered `gitferry://open` URL handler. No MCP server, configuration, token, or extra package is needed. The OS launches or activates GitFerry, which handles repeated clicks, startup, and unsaved editor buffers. Local and explicit SSH file locations stay separate, and GitFerry discovers the nearest repository/worktree. File opening requests are sent in click order. Opening a link never edits or saves files, stages changes, or switches branches.

Each reply with applied file edits shows a changed-files summary outside the activity log. Expand or collapse the list, click a file to expand its highlighted diff inline, or open it in your selected editor. Click the file again to collapse it; expanded files stay open when more edits arrive. Reading a diff pauses automatic scrolling and keeps it anchored while output continues; **Jump to latest** resumes following the conversation. Counts describe added and removed lines across the recorded edits; failed or declined patches are excluded. Summaries also appear when reopening conversation history. Changes made only through shell commands are shown when Codex reports them as file-change items.

Hover over a message and click its pin icon to keep a short preview in the slim row above the conversation. Click the preview to jump to the original message; older history loads as needed, and automatic scrolling pauses while you read. **Jump to latest** resumes following new output. Click the pin again or **×** beside its preview to unpin. Up to 50 message pins per conversation survive restarts, separately for each machine; pins also work while Codex is running.

Inline diffs use GitFerry-style green/red row backgrounds, stronger changed-word highlights, old/new line numbers, and compact hunk separators. Copied patch text excludes the visual line numbers. Pinned messages and their top previews have a subtle yellow highlight in every theme.

The small shortcut row above the prompt sends a saved message immediately, or queues it behind the current turn. **Review** sends `$cr ur changes` with the actual `cr` skill attached from the conversation’s workspace. Use **+** to add a shortcut and right-click one to edit or delete it. Each shortcut has a **When clicked** choice: **Send / queue immediately** or **Fill prompt only**. Fill mode adds its text to your existing draft, focuses the prompt, and waits for you to send; skill references resolve when sent. Existing shortcuts keep autosending by default. Shortcuts and their click behavior survive restarts. Autosend shortcuts preserve your typed message and image drafts and send now regardless of the composer’s scheduling selector. Missing skills show an error instead of sending plain text.

## Development

Requires Node.js 22+. For local use, install and sign in to Codex; for SSH use, have an SSH key that connects without an interactive prompt.

```sh
npm ci
npm start
npm test
npm run test:renderer
npm run test:live
```

`test:renderer` checks menus, compact layout, queue editing/steering, image drafts, project grouping/creation/moves, and history behavior in an isolated Electron window without external services.

`test:live` creates a temporary conversation on `root@warmer`, runs a text-only inference, reconnects and checks persisted history, then archives its own test conversation. Set `CODEX_TEST_HOST` to test another host.

Desktop end-to-end tests (real inference and a read-only `pwd`):

```sh
npx electron . --smoke-test
npx electron . --smoke-test --local
```

These check reply sanitization, history streaming, approval drafts, mode settings, pins, and the folder picker in an isolated renderer, then test the selected connection. They use isolated app settings, save screenshots and results to `artifacts/ssh/` or `artifacts/local/`, and unpin/archive their test conversation after success.

## Build

```sh
npm run package:mac
npm run package:win
```

For local macOS updates, run `npm run package:mac` then `npm run install:mac`. Reuse the fixed `dist/Remote Codex-darwin-x64` output instead of per-feature build folders. The installer verifies the staged app, swaps it without restarting running chats, and keeps just one compressed rollback at `~/Applications/.Remote-Codex-rollback.zip`. Old `.Remote-Codex-before-*` folders are removed unless a running app still uses them; after restarting, `npm run cleanup:mac` removes those remaining copies. Cleanup verifies the rollback archive before deleting backups. Builds exclude tests, installer scripts, and icon design previews.

The app bundles its runtime; SSH mode does not need a local Node.js installation. The macOS build targets Intel Macs and macOS 12+. Electron 43 is pinned because Electron 44+ requires macOS 13. For an Apple Silicon build, use the same packager command with `--arch=arm64`. Builds are unsigned local builds. Windows output is a portable folder containing `Remote Codex.exe`; copy the whole folder.

The app uses the official [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server) over local or SSH stdio. Sandboxed renderer, isolated preload, local-only content, sanitized Markdown, strict SSH host verification, and no listening server ports.

Remote Codex prevents automatic idle sleep while any chat is working; the screen can still sleep. The hold releases when all chats finish, stop, fail, or disconnect, and when the app exits.
