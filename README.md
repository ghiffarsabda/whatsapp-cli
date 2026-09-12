# whatsapp-cli

A terminal WhatsApp client with **persistent login**, text messages only. Built to be driven equally well by humans and AI agents.

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
read     <chat> [--limit <n>] [--since <ts>] [--before <ts>]
send     <chat> <text|-> [--body-file <path>]
watch    [chat] [--once] [--timeout <ms>]          stream incoming messages
wait     <chat> [--timeout <ms>] [--include-from-me]
search   <query> [--chat <chat>] [--limit <n>] [--since <ts>]
daemon   start|stop|restart|status|logs [--follow] [--lines <n>]
tui                                                interactive full-screen UI (TTY only)
schema                                             machine-readable self-description
```

`<chat>` accepts a full JID, a phone number (`+62811...`), an exact contact or group name, or a unique name substring.

## Interactive UI

`wa tui` is a full-screen client for the same daemon: a chat list on the left, the conversation on the right, a composer along the bottom, and a footer showing connection state and unread totals.

```
┌─ Budi (2) ───────┐┌─ Budi ────────────────────────────────┐
│ ▸ Budi        (2)││ 20:14 Budi: halo                      │
│   Team Standup   ││ 20:15 me: hi back                     │
└──────────────────┘└───────────────────────────────────────┘
> press i to write
j/k move · enter open · tab pane · q quit        open
```

| Pane | Keys |
|---|---|
| **Chat list** | `j`/`k` or arrows move (wraps) · `g`/`G` first/last · `enter` or `l` open · `/` write · `q` quit |
| **Messages** | `j`/`k` or arrows scroll · `pgup`/`pgdn` page · `o` load older · `G` jump to newest · `i` or `enter` write · `q` quit |
| **Composer** | `enter` send · `esc` back to the list · `←`/`→` move the caret · `↑`/`↓` message history · `ctrl+a`/`ctrl+e` line ends · `ctrl+u` clear |
| **Anywhere** | `tab` cycle panes · `ctrl+c` quit |

Notes:

- It needs a real terminal. Piped or redirected invocations exit `2` rather than loading React, and `--json` is rejected for the same reason.
- Incoming messages stream in over the daemon's existing subscription, so the chat list re-sorts and unread badges update live. A chat you have open never counts as unread.
- It refuses to start when not logged in (exit `3`); run `wa login` first.
- Messages are held in memory per chat (newest 300) and marked read through the daemon, so the same history shows up in `wa read` afterwards.

## Where things live

Everything is XDG-compliant and overridable with `WHATSAPP_CLI_DATA_DIR`.

```
~/.local/share/whatsapp-cli/
├── auth/                 credentials (0700) — delete this to force a re-login
├── messages.jsonl        append-only source of truth, one JSON message per line
├── chats.json            chat index snapshot: names, unread counts
├── state.json            live daemon state — `cat` it to check connection status
└── daemon.log            daemon logs

$XDG_RUNTIME_DIR/whatsapp-cli/daemon.sock    control socket (0600)
```

A message record looks like this:

```json
{"id":"3EB0...","chat":"628111@s.whatsapp.net","chatName":"Budi","from":"628111@s.whatsapp.net","fromName":"Budi","fromMe":false,"ts":1757673600,"type":"text","text":"halo","replyTo":null}
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
npm test            # node:test, 108 tests
npm run typecheck
npm run dev -- status   # run from source via tsx
```

```
src/
├── bin/wa.ts              entry point, flag parsing, exit-code mapping
├── cli/                   output contract, IPC client, auto-spawn, commands
├── daemon/                Baileys connection, IPC server, methods, store, ingest
├── tui/                   Ink app, keymap, view logic, components
└── shared/                paths, errors, protocol, JID handling
```

The two files worth reading first are `src/cli/output.ts` (the agent-facing contract) and `src/daemon/baileys.ts` (the reconnect state machine).

## v1 scope

Text in and out. Deliberately **not** included: media download/upload, reactions, edits, deletes, read receipts, presence, group administration, broadcasts, stories, multi-account. `search` is a linear scan over the log and is documented as such.

## Caveats

- Baileys is unofficial and not affiliated with WhatsApp. Automated messaging carries a **ban risk** — use it for personal automation, not bulk or unsolicited messaging.
- Pinned to `@whiskeysockets/baileys@6.7.24` (the `legacy` tag, above the 6.7.22 security advisory). The `latest` tag is a release candidate with breaking changes; migrating to it is future work.
