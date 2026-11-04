# Remote Codex

A desktop GUI for running Codex locally or on your server over SSH. Conversations are on the left, messages and tool activity on the right. Supports macOS and Windows.

## Installed on this Mac

- Source: `/Users/EugeneBos/Websites/remote-codex`
- Application: `/Users/EugeneBos/Applications/Remote Codex.app`
- Server: `root@warmer`

Open **Remote Codex** from Applications or Spotlight. It reconnects to your last machine automatically. Click the machine card at bottom left, choose **This machine · Local** or **Remote machine · SSH**, then **Save & connect**. Existing SSH settings stay remote; fresh installations start locally. Local and remote workspace settings are saved separately.

Choose a theme in **Settings → Theme**: System, Light, Dark, Purple, Claude Code, Nord, or Midnight. Themes apply immediately and persist after restarting. Claude Code uses warm colors and monospace text.

Right-click a project → **Open only this project** to hide other projects and their conversations. This view loads 50 conversations at a time; **All projects** returns to the full sidebar. In **Project settings…**, enable **Open this project when the app starts** to make it the startup view for the connected machine. New conversations use that project's folder. Themes and startup project choices are saved in the app's local `preferences.json`.

Click **New conversation → Browse** or **Choose project** to select a folder on the connected machine. Any folder can be a project. Selecting a folder from an existing conversation starts a new conversation there; existing conversations keep their original folder. Selecting a conversation reads its history without taking a writer lock. Sending a message acquires the writer only when needed. If another Codex process owns that conversation, a compact notice keeps the draft intact and offers **Retry**; closing a tab in another app may leave its server running and retaining the lock. Stop or close that owning session/server before retrying. Use the model, reasoning, and access controls under the message box. **Stop** interrupts the current turn.

Click **+** beside **CONVERSATIONS** to add a saved project: choose its folder and name. Projects appear as collapsible sidebar groups, with five recent conversations and **Load more conversations** below each group. Use **+** beside a project to start a chat in its saved folder. Right-click a project or use its **⋯** menu to rename it or move it up/down. Drag a project heading above or below another project to reorder them; names and order are saved in Codex. **New conversation** continues using the selected project. Drag a conversation onto a project group or back onto **Other conversations** to move it, including into collapsed projects. You can also right-click and choose **Move to project…**, or **No project** to return it to other conversations. Project definitions and conversation membership use Codex's native project API and persist on the connected machine; local and SSH projects stay separate.

Hover a conversation and click its pin icon to move it to the top of its project, or into **Pinned** above other conversations when it has no project. Click the pin again to unpin. Pins persist after restarting the app, stay visible beyond the first page of history, and are separate for local Codex and each SSH host/port. They are saved by this client and do not sync to other Codex apps.

Conversations show a spinner while Codex is working, a green dot when a reply finishes, and a red dot if a turn fails. Opening the conversation clears its completion dot. These indicators work for pinned and recent conversations.

Right-click a conversation and choose **Mark as unread**, or press **⌘⇧U** on Mac / **Ctrl+Shift+U** on Windows for the selected chat. Unread chats have bold titles and a blue dot; working chats keep their spinner. Unread markers are saved by this app separately for each machine and clear when you reopen the conversation.

The compact sidebar shows one title line, with **Load more conversations** at the bottom of the scrolling list. Chats without a title immediately show the beginning of their first prompt, then replace it with a title generated using OpenRouter `openai/gpt-4.1-nano`; the generated title is checked against the request language before being saved on the connected Codex machine. A mismatched or uncertain language keeps the original prompt preview. Right-click a conversation and choose **Rename conversation** to set your own title. Manual titles are preserved. The first 4,000 characters of the initial prompt are sent to OpenRouter for title generation; images are not sent to the title service. The key stays in the main process, using `OPENROUTER_API_KEY` or the encrypted `title-key.enc` in the app settings folder. This Mac has an encrypted key configured; other installations need their own key.

Right-click a conversation and choose **Clone conversation** to copy its history into a separate chat. Hover an earlier user prompt and choose **Edit & resend** to branch before that turn and send a revised prompt, keeping its attachments. The original chat remains available; existing file changes are not undone. Both actions keep the original workspace and project. Messages added with Steer belong to their original turn; edit that turn's initial prompt to branch from its beginning.

While Codex is running, **Enter** or **Queue** saves a follow-up to send when the turn finishes. Queued messages appear above the composer; remove one with **×** or use **Steer** to send it into the current turn. Click the queued text or **Edit** to change it; **Steer** appears only on queued messages and sends that message into the running turn. An open queue editor pauses automatic sending until saved or closed. Queues, edits, images, and skill attachments are saved on this computer and survive app restarts. They stay separate for each conversation and machine. Restored queues, failed or interrupted turns, reconnects, and lost connections leave messages paused as **Waiting**; opening a chat does not send them. Use **Retry** to resume sending, or **Steer** to explicitly send a queued message into an active turn. Healthy queues still send automatically after a successful turn. Failed sends stay queued for review and retry. Conversations open at the end without a scrolling animation.

Command and tool rows show one line by default. Click to expand the full command and output. Scrollbars use a thin, muted style. The app icon uses a monochrome folded R on a dark rounded-square tile.

Type `/` in the composer to search commands and installed skills on the connected machine. Use ↑/↓ to select, Enter or Tab to choose, and Esc to dismiss. Commands include `/new`, `/model`, `/reasoning`, `/permissions`, `/plan`, `/review`, `/compact`, `/skills`, `/init`, `/project`, `/rename`, `/status`, and `/mcp`. Selecting a skill inserts its `$name` and attaches its skill path when sent. `/plan` toggles Plan mode for future messages; `/plan off` returns to normal mode. `/review` applies the selected access settings before reviewing uncommitted changes; if applying settings fails, the review does not start. `/compact` compacts conversation context.

Local mode uses the installed Codex, its existing login/configuration, and its conversation history. It prefers the current managed Codex runtime used by the desktop app, then checks PATH, common install paths, and nvm installations, including when launched from Finder. Set **Codex executable** to an absolute path to override discovery. An npm-installed Codex also needs its Node.js runtime. No separate API key is needed when Codex is already signed in.

SSH mode uses the server's Codex login and configuration. SSH credentials are handled by the system SSH client; the app saves only host, port, key *path*, and default workspace. The server must already be trusted in `~/.ssh/known_hosts` (`ssh root@warmer` once if setting up another computer). Encrypted keys work through your SSH agent or macOS Keychain. The app never copies private keys.

Default access is **Workspace access** with approval prompts. **Read only** prevents edits. **Full local access** or **Full server access** gives Codex the connected account's filesystem access and runs commands without approval prompts. The access selection is saved separately for each machine. Commands and conversation history stay on the selected machine. Closing the app or switching machines disconnects its app-server process; keep the app connected while a task runs. Reconnect after an interruption, then reopen the conversation. Requests that time out may already have reached Codex; check history before resending.

Drag images onto the chat, paste an image, or click **＋** to attach images. Review or remove previews before sending. Supports PNG, JPEG, WebP, and GIF (up to 10 images, 20 MB total); image-only messages work too. Images are sent over the active local/SSH connection and saved in Codex conversation history. Reopening the selected chat keeps its image draft. The composer briefly prevents editing while a send is being accepted, then restores typing without losing focus.

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

The app bundles its runtime; SSH mode does not need a local Node.js installation. The macOS build targets Intel Macs and macOS 12+. Electron 43 is pinned because Electron 44+ requires macOS 13. For an Apple Silicon build, use the same packager command with `--arch=arm64`. Builds are unsigned local builds. Windows output is a portable folder containing `Remote Codex.exe`; copy the whole folder.

The app uses the official [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server) over local or SSH stdio. Sandboxed renderer, isolated preload, local-only content, sanitized Markdown, strict SSH host verification, and no listening server ports.

Remote Codex prevents automatic idle sleep while any chat is working; the screen can still sleep. The hold releases when all chats finish, stop, fail, or disconnect, and when the app exits.
