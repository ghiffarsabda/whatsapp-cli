# whatsapp-cli

A fast, feature-packed terminal WhatsApp client with **persistent login**, voice note playback & sending, image viewing (Ctrl+Click), documents, contact search, group sync, and responsive TUI chat cards. Built to be driven equally well by humans and AI agents.

Log in once. After that every command just works — across daemon restarts and reboots — because credentials live on disk and a background daemon keeps the connection alive.

```bash
wa login                      # scan a QR once
wa send "+628111222333" "hello from the terminal"
wa chats
wa read Budi --limit 20
wa watch                      # stream incoming messages
wa wait Budi --timeout 60000  # block until Budi replies
wa tui                        # full-screen UI: browse, read, reply
```

---

## Why there is a daemon

To **receive** a message, a process must hold an open WebSocket to WhatsApp. A short-lived CLI process cannot do that, no matter what is on disk. So:

- A **daemon** owns the Baileys socket, the credentials, and the message log.
- The **CLI is a thin client** that connects over a Unix socket, makes one request, prints one result, and exits.

You never start the daemon by hand: any command auto-spawns it if it is not running.

```
wa <command>  ──NDJSON over a Unix socket──▶  daemon
                                              ├─ Baileys socket (persistent, auto-reconnect)
                                              ├─ auth/ (credentials — survives reboot)
                                              ├─ messages.jsonl + chats.json
                                              └─ state.json
```

## Install

```bash
git clone https://github.com/ghiffarsabda/whatsapp-cli.git
cd whatsapp-cli
npm install
npm run build
npm link            # puts `wa` on your PATH
```

The package is named `whatsapp-cli` but it installs exactly one command, **`wa`**. That is deliberate: it leaves the name `whatsapp-cli` free for other tools you may already have on your PATH.

Without linking, you can always run it directly:

```bash
./dist/bin/wa.js <command>
npm run dev -- <command>     # straight from TypeScript, no build
```

> If `npm install` skips dev dependencies, your environment has `NODE_ENV=production`. Use `NODE_ENV=development npm install --include=dev` to build and test.

Requires Node 20 or newer (Node 24 recommended).

## Persistent login

This is the whole point, so it is worth being precise about how it works:

1. `wa login` renders a QR (or a pairing code with `--phone +62811...`) and waits until the link completes.
2. Baileys' `useMultiFileAuthState` writes credentials to `auth/` and updates them on every `creds.update` — including the Signal key churn that, if skipped, silently stops your messages being delivered.
3. On any disconnect the daemon reconnects with exponential backoff (1s → 30s cap). It **never re-pairs**.
4. Credentials are only discarded if you run `wa logout --yes`, or if WhatsApp itself unlinks the device.

Verify it for yourself:

```bash
wa daemon restart && wa status   # loggedIn: true, qr: null, same me.jid
```

## Using it from an agent

The CLI is designed so an agent never has to scrape prose or guess.

| Behaviour | Detail |
|---|---|
| **Auto JSON** | When stdout is not a TTY you get `{"ok":true,"data":...}` with no flags. Override with `--format=text`. |
| **Structured errors** | `{"ok":false,"error":{"code","message","hint","details?"}}`. Ambiguity returns the candidate JIDs in `details.candidates`. In text mode errors go to stderr, so stdout stays parseable. |
| **Stable exit codes** | `0` ok · `1` unexpected · `2` usage · `3` not logged in · `4` daemon unreachable · `5` not found/ambiguous · `6` send rejected · `7` timeout |
| **Self-description** | `wa schema` dumps every command, argument, flag, output shape, exit code, env var, and resolved path as JSON. |
| **Never prompts** | Destructive operations need an explicit `--yes` and fail with exit 2 otherwise. |
| **Bounded** | Every command takes `--timeout` and cannot hang. `--timeout 0` (wait forever) is only honoured by `watch`. |
| **stdin bodies** | `printf 'multi\nline' \| wa send Budi -` or `--body-file path` — no shell escaping games. |
| **Ambiguity is explicit** | `wa send budi` matching two chats exits 5 with the candidate JIDs in the hint, instead of guessing. |
| **`wait`** | `wa send Budi "ping" && wa wait Budi --timeout 60000` is a complete request/response loop. |
| **NDJSON streams** | `wa watch --json` emits one event per line, flushed immediately — pipe it into `jq`. |
| **Skip the CLI entirely** | The message log is plain JSONL: `tail -f ~/.local/share/whatsapp-cli/messages.jsonl \| jq` |

Agent config via environment: `WHATSAPP_CLI_JSON=1`, `WHATSAPP_CLI_TIMEOUT`, `WHATSAPP_CLI_DATA_DIR`, `WHATSAPP_CLI_SOCKET`, `WHATSAPP_CLI_COUNTRY`, `NO_COLOR`.

## Commands

```
login    [--phone <n>] [--wait] [--timeout <ms>]   link this device (one-time)
logout   --yes                                     unlink and delete credentials
status                                             daemon + connection state
chats    [--limit <n>] [--search <t>] [--unread]   chats by recent activity
contacts [--limit <n>] [--search <t>]              list contacts and groups
sync                                               sync groups and contacts from device
read     <chat> [--limit <n>] [--since <ts>] [--before <ts>]
send     <chat> <text|-> [--image <path>] [--voice <path>] [--document <path>] [--caption <t>]
play     <chat> [messageId]                        listen to voice notes or audio
watch    [chat] [--once] [--timeout <ms>]          stream incoming messages
wait     <chat> [--timeout <ms>] [--include-from-me]
search   <query> [--chat <chat>] [--limit <n>] [--since <ts>]
daemon   start|stop|restart|status|logs [--follow] [--lines <n>]
tui                                                interactive full-screen UI (TTY only)
schema                                             machine-readable self-description
```

`<chat>` accepts a full JID, a phone number (`+62811...`), an exact contact or group name, or a unique name substring.

### Sending Media & Voice Notes

You can send media from the CLI or directly from within the TUI composer:

- **CLI flags**:
  ```bash
  wa send Budi --voice ./note.ogg
  wa send Budi --image ./photo.jpg --caption "vacation picture"
  wa send Budi --document ./report.pdf --caption "quarterly report"
  ```
- **Composer / CLI syntax**:
  ```
  @voice /path/to/audio.ogg
  @image /path/to/picture.jpg Optional caption here
  @document /path/to/invoice.pdf Invoice for March
  ```

### Listening to Voice Notes & Viewing Images

- Inbound voice notes and audio are automatically decrypted and saved locally under `~/.local/share/whatsapp-cli/media/<chat>/`.
- Run `wa play <chat>` to listen to the latest voice note via `mpv`, `ffplay`, or `aplay`.
- In the TUI, press `p` to play the most recent voice note in the active chat, or `v` to view the most recent image in your default image viewer.
- Image paths are also rendered as terminal OSC 8 hyperlinks (`file:///...`), allowing **Ctrl+Click** directly inside modern terminals (GNOME Terminal, iTerm2, Alacritty, Windows Terminal, VS Code).

## Interactive UI

`wa tui` is a fast full-screen client: chat cards on the left, full message stream on the right, composer along the bottom, and connection status in the footer.

- **Chat Room Cards**: Every conversation (direct or group) is rendered in its own distinct card with `[GRP]` / `[DIR]` tags, full names, timestamp, and unread badges.
- **Contact Search & New Chats (`n` or `/`)**: Press `n` or `/` from the chat list to search your address book and group directory. Type any name, number, or JID, and press `enter` to immediately open or start the chat.
- **Auto-Sync & Reconnect**: Automatically re-syncs participating groups and missed messages upon network reconnection. You can also press `s` anytime to trigger a manual sync.
- **Full Contact Names**: Displays full address book contact names rather than just first names or fallback push names.
- **Historical Messages**: Seamlessly displays history for both group chats and 1-on-1 conversations, with `o` to load older messages.

| Context | Keys | Action |
|---|---|---|
| **Chat list** | `j`/`k` or `↑`/`↓` | Navigate chat cards |
| | `enter` or `l` | Open selected chat |
| | `n` or `/` | Search contacts or start new chat |
| | `s` | Sync device & group chats |
| | `q` | Quit |
| **Messages** | `j`/`k` or `↑`/`↓` | Scroll messages |
| | `o` | Load older history |
| | `G` | Jump to newest messages |
| | `p` | Play selected/latest voice note |
| | `v` | View/open selected/latest image or document |
| | `i` | Write a reply (only `i` enters the composer; `esc` leaves it) |
| | `q` | Quit |
| **Composer** | `enter` | Send message (supports `@voice`, `@image`, `@document`) |
| | `esc` | Back to chat cards |
| | `←`/`→` | Move caret |
| | `ctrl+u` | Clear line |
| **Anywhere** | `tab` | Toggle chat list ⇄ chat room |
| | `ctrl+c` | Force quit |

Notes:

- It needs a real terminal. Piped or redirected invocations exit `2` rather than loading React, and `--json` is rejected for the same reason.
- Incoming messages stream in over the daemon's existing subscription, so the chat list re-sorts and unread badges update live. A chat you have open never counts as unread.
- Messages for chats you are not looking at raise a desktop notification (`notify-send` on Linux, `osascript` on macOS, terminal bell elsewhere). Set `WHATSAPP_CLI_NO_NOTIFY=1` to silence them.
- Received images, documents, voice notes and audio are downloaded on arrival, so `v` opens PDFs/docs in your default app and `p` plays voice notes.
- It refuses to start when not logged in (exit `3`); run `wa login` first.
- Messages are held in memory per chat (newest 300) and marked read through the daemon, so the same history shows up in `wa read` afterwards.

## Where things live

Everything is XDG-compliant and overridable with `WHATSAPP_CLI_DATA_DIR`.

```
~/.local/share/whatsapp-cli/
├── auth/                 credentials (0700) — delete this to force a re-login
├── media/                decrypted media (voice notes, images, documents)
├── messages.jsonl        append-only source of truth, one JSON message per line
├── chats.json            chat and contact index snapshot: names, unread counts
├── state.json            live daemon state — `cat` it to check connection status
└── daemon.log            daemon logs

$XDG_RUNTIME_DIR/whatsapp-cli/daemon.sock    control socket (0600)
```

A message record looks like this:

```json
{"id":"3EB0...","chat":"628111@s.whatsapp.net","chatName":"Budi","from":"628111@s.whatsapp.net","fromName":"Budi","fromMe":false,"ts":1757673600,"type":"audio","text":"[voice note 0:34]","mediaPath":"/home/.../media/...ogg","duration":34,"replyTo":null}
```

Set an explicit `WHATSAPP_CLI_DATA_DIR` (or `--data-dir`) and the socket moves inside it too, so isolated instances never collide.

## Run it as a service

The daemon auto-starts on demand, so this is optional. To keep the connection alive from boot:

```ini
# ~/.config/systemd/user/whatsapp-cli.service
[Unit]
Description=whatsapp-cli daemon
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/.local/share/../path/to/whatsapp-cli/dist/daemon/main.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now whatsapp-cli
```

## Development

```bash
npm run build       # tsc -> dist/
npm test            # node:test, 125 tests
npm run typecheck
npm run dev -- status   # run from source via tsx
```

```
src/
├── bin/wa.ts              entry point, flag parsing, exit-code mapping
├── cli/                   output contract, IPC client, auto-spawn, commands
├── daemon/                Baileys connection, IPC server, methods, store, ingest
├── tui/                   Ink app, keymap, view logic, components
└── shared/                paths, errors, protocol, JID handling, media player
```

The files worth reading first are `src/cli/output.ts` (the agent-facing contract) and `src/daemon/baileys.ts` (the reconnect and media handling state machine).

## Features

- **Text & Media**: Supports text messages, voice notes (`.ogg`/`.mp3` with opus/ptt), images, and documents.
- **One identity per person**: WhatsApp addresses the same contact by both a phone number (`@s.whatsapp.net`) and an anonymous LID (`@lid`). The daemon discovers the pair from message keys, contact records, group metadata and `onWhatsApp`, then merges them — so a conversation never splits across two chat rooms.
- **Group & Direct Chat History**: Group subjects, participating chats, and contact names are automatically indexed and synced across restarts.
- **Snappy Terminal UI**: Visual chat cards, instant contact fuzzy finder modal, terminal hyperlinks (Ctrl+Click), and hotkeys for media playback (`p`) and viewing (`v`).
- **Resilient & Reconnecting**: Auto-syncs missed events upon network reconnection; credentials and message stores survive daemon restarts.

## Caveats

- Baileys is unofficial and not affiliated with WhatsApp. Automated messaging carries a **ban risk** — use it for personal automation, not bulk or unsolicited messaging.
- Pinned to `@whiskeysockets/baileys@6.7.24` (the `legacy` tag, above the 6.7.22 security advisory). The `latest` tag is a release candidate with breaking changes; migrating to it is future work.
