import { paths } from '../../shared/paths.js'
import { VERSION } from '../../shared/version.js'

export interface FlagSpec {
  name: string
  type: 'string' | 'number' | 'boolean'
  description: string
  default?: unknown
  env?: string
}

export interface ArgSpec {
  name: string
  required: boolean
  description: string
}

export interface CommandSpec {
  name: string
  summary: string
  args?: ArgSpec[]
  flags?: FlagSpec[]
  output: string
  exitCodes: number[]
  notes?: string[]
}

const GLOBAL_FLAGS: FlagSpec[] = [
  { name: '--json', type: 'boolean', description: 'Emit a single JSON object on stdout', env: 'WHATSAPP_CLI_JSON' },
  { name: '--format', type: 'string', description: 'Output format: json or text', default: 'auto (json when stdout is not a TTY)' },
  { name: '--no-color', type: 'boolean', description: 'Disable ANSI color', env: 'NO_COLOR' },
  { name: '--timeout', type: 'number', description: 'Request timeout in milliseconds', default: 30000, env: 'WHATSAPP_CLI_TIMEOUT' },
  { name: '--data-dir', type: 'string', description: 'Override the data directory', env: 'WHATSAPP_CLI_DATA_DIR' },
  { name: '--quiet', type: 'boolean', description: 'Suppress success output in text mode' },
]

const COMMANDS: CommandSpec[] = [
  {
    name: 'login',
    summary: 'Link this device. One-time: credentials persist on disk afterwards.',
    flags: [
      { name: '--phone', type: 'string', description: 'Pair with a phone number (E.164 digits) instead of scanning a QR' },
      { name: '--wait', type: 'boolean', description: 'In JSON mode, wait until linked before returning', default: false },
      { name: '--timeout', type: 'number', description: 'Give up after this many milliseconds (text mode)' },
    ],
    output: '{ connection, loggedIn, me, qr, pairingCode, pid, startedAt, ... }',
    notes: [
      'Text mode renders the QR and blocks until linked.',
      'JSON mode returns immediately with the raw qr payload; poll `status` to detect completion.',
    ],
    exitCodes: [0, 3, 7],
  },
  {
    name: 'logout',
    summary: 'Unlink the device and delete local credentials.',
    flags: [{ name: '--yes', type: 'boolean', description: 'Required acknowledgement' }],
    output: '{ loggedIn: false, viaDaemon }',
    exitCodes: [0, 2],
  },
  {
    name: 'status',
    summary: 'Show daemon and connection state.',
    output: '{ connection, loggedIn, me, qr, reconnect, lastDisconnect, chatCount, subscribers, pid }',
    exitCodes: [0, 4],
  },
  {
    name: 'chats',
    summary: 'List chats by most recent activity.',
    flags: [
      { name: '--limit', type: 'number', description: 'Maximum chats to return' },
      { name: '--search', type: 'string', description: 'Filter by name or JID substring' },
      { name: '--unread', type: 'boolean', description: 'Only chats with unread messages' },
    ],
    output: '{ chats: [{ jid, name, isGroup, lastTs, lastText, unread }] }',
    exitCodes: [0, 4],
  },
  {
    name: 'read',
    summary: 'Read stored messages from a chat. Marks the chat read.',
    args: [{ name: 'chat', required: true, description: 'JID, phone number, or contact/group name' }],
    flags: [
      { name: '--limit', type: 'number', description: 'Maximum messages (newest last)', default: 50 },
      { name: '--since', type: 'number', description: 'Only messages at or after this unix timestamp' },
      { name: '--before', type: 'number', description: 'Only messages before this unix timestamp' },
    ],
    output: '{ chat: { jid, name }, messages: [{ id, chat, from, fromMe, ts, type, text, replyTo }] }',
    exitCodes: [0, 4, 5],
  },
  {
    name: 'send',
    summary: 'Send a text message.',
    args: [
      { name: 'chat', required: true, description: 'JID, phone number, or chat name' },
      { name: 'text', required: true, description: 'Message body, or "-" to read from stdin' },
    ],
    flags: [{ name: '--body-file', type: 'string', description: 'Read the body from a file' }],
    output: '{ messageId, chat, timestamp }',
    notes: ['Phone numbers are normalized with a default country from WHATSAPP_CLI_COUNTRY.'],
    exitCodes: [0, 2, 3, 4, 5, 6, 7],
  },
  {
    name: 'watch',
    summary: 'Stream incoming messages.',
    args: [{ name: 'chat', required: false, description: 'Limit to one chat' }],
    flags: [
      { name: '--once', type: 'boolean', description: 'Exit after the first message' },
      { name: '--timeout', type: 'number', description: 'Exit after this many milliseconds; 0 streams forever', default: 0 },
    ],
    output: 'NDJSON: {"event":"message","data":{...}}',
    notes: ['Timeout is normal termination and exits 0.'],
    exitCodes: [0, 4],
  },
  {
    name: 'wait',
    summary: 'Block until the next inbound message in a chat, print it, exit.',
    args: [{ name: 'chat', required: true, description: 'JID, phone number, or chat name' }],
    flags: [
      { name: '--timeout', type: 'number', description: 'Give up after this many milliseconds; 0 waits forever', default: 30000 },
      { name: '--include-from-me', type: 'boolean', description: 'Also match messages you sent' },
    ],
    output: '{ id, chat, from, fromMe, ts, type, text }',
    notes: ['The primitive for send -> wait -> reply agent loops.'],
    exitCodes: [0, 4, 5, 7],
  },
  {
    name: 'search',
    summary: 'Search message text. Linear scan over the local log.',
    args: [{ name: 'query', required: true, description: 'Case-insensitive substring' }],
    flags: [
      { name: '--chat', type: 'string', description: 'Limit to one chat' },
      { name: '--limit', type: 'number', description: 'Maximum matches', default: 50 },
      { name: '--since', type: 'number', description: 'Only messages at or after this unix timestamp' },
    ],
    output: '{ query, messages: [...] }',
    exitCodes: [0, 4, 5],
  },
  {
    name: 'daemon',
    summary: 'Control the background process that holds the WhatsApp connection.',
    args: [{ name: 'action', required: true, description: 'start | stop | restart | status | logs' }],
    flags: [
      { name: '--lines', type: 'number', description: 'Log tail size for `logs`', default: 50 },
      { name: '--follow', type: 'boolean', description: 'Stream new log lines (logs only)' },
    ],
    output: 'Varies by action.',
    notes: ['Any other command auto-starts the daemon if it is not running.'],
    exitCodes: [0, 4],
  },
  {
    name: 'tui',
    summary: 'Interactive full-screen terminal UI: chat list, message pane, composer.',
    flags: [],
    output: 'None. Paints the terminal and restores it on exit.',
    notes: [
      'Requires an interactive TTY; exits 2 when piped or redirected.',
      'Keys: j/k move · enter open · tab toggles list/chat · i write · esc back · p play · v open · q quit.',
      'Inbound images, documents and audio are downloaded; notifications fire for chats you are not viewing (WHATSAPP_CLI_NO_NOTIFY=1 to silence).',
    ],
    exitCodes: [0, 2, 3, 4],
  },
  {
    name: 'schema',
    summary: 'Print this machine-readable description of the CLI.',
    output: 'This document.',
    exitCodes: [0],
  },
]

/** Full self-description, so an agent can discover the CLI in one call. */
export function buildSchema(): unknown {
  const target = paths()
  return {
    name: 'whatsapp-cli',
    command: 'wa',
    version: VERSION,
    description:
      'Terminal WhatsApp client with persistent login. Text messages only. ' +
      'A background daemon holds the connection; commands are thin IPC clients.',
    invocation: {
      binaries: ['wa'],
      usage: 'wa <command> [args] [flags]',
    },
    globalFlags: GLOBAL_FLAGS,
    exitCodes: {
      '0': 'ok',
      '1': 'unexpected error',
      '2': 'usage error',
      '3': 'not logged in',
      '4': 'daemon unreachable or failed to start',
      '5': 'target not found or ambiguous',
      '6': 'send rejected',
      '7': 'timeout',
    },
    environment: {
      WHATSAPP_CLI_JSON: 'Force JSON output (any non-empty value except 0/false)',
      WHATSAPP_CLI_DATA_DIR: 'Data directory',
      WHATSAPP_CLI_SOCKET: 'Daemon socket path',
      WHATSAPP_CLI_TIMEOUT: 'Default request timeout in ms',
      WHATSAPP_CLI_COUNTRY: 'Default country for phone number parsing, e.g. ID',
      WHATSAPP_CLI_LOG_LEVEL: 'Daemon log level',
      NO_COLOR: 'Disable ANSI color',
    },
    paths: {
      dataDir: target.dataDir,
      authDir: target.authDir,
      messagesLog: target.messagesFile,
      chatsIndex: target.chatsFile,
      state: target.stateFile,
      daemonLog: target.logFile,
      socket: target.socketPath,
    },
    agentTips: [
      'stdout carries only the result; errors go to stderr in text mode.',
      'JSON mode always emits exactly one object: {"ok":true,"data":...} or {"ok":false,"error":{code,message,hint}}.',
      'The message log is plain JSONL and can be read directly with jq/tail instead of using this CLI.',
      'No command ever prompts, and every read is safe to run concurrently.',
    ],
    commands: COMMANDS,
  }
}

export async function schemaCommand(): Promise<void> {
  process.stdout.write(`${JSON.stringify(buildSchema(), null, 2)}\n`)
}
