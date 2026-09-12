import type { ChatSummary, DaemonState, MessageRecord } from '../shared/protocol.js'
import { paint, type OutputOptions } from './output.js'

function timestamp(seconds: number): string {
  const date = new Date(seconds * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

function shortJid(jid: string): string {
  return jid.split('@')[0] ?? jid
}

export function renderState(state: DaemonState & { chatCount?: number }): string {
  const lines = [
    `connection   ${state.connection}`,
    `logged in    ${state.loggedIn ? 'yes' : 'no'}`,
    `me           ${state.me ? `${state.me.name ?? ''} <${state.me.jid}>`.trim() : '-'}`,
    `pid          ${state.pid}`,
    `uptime since ${state.startedAt}`,
  ]
  if (state.chatCount !== undefined) lines.push(`chats        ${state.chatCount}`)
  if (state.qr) lines.push('qr           pending (run `wa login`)')
  if (state.pairingCode) lines.push(`pairing code ${state.pairingCode.code}`)
  if (state.reconnect.attempts > 0) {
    lines.push(`reconnect    attempt ${state.reconnect.attempts} (next ${state.reconnect.nextAt ?? '-'})`)
  }
  if (state.lastDisconnect) {
    lines.push(`last error   ${state.lastDisconnect.message} (${state.lastDisconnect.statusCode ?? '-'})`)
  }
  return lines.join('\n')
}

export function renderChats(chats: ChatSummary[], options: OutputOptions): string {
  if (chats.length === 0) return 'No chats yet.'

  return chats
    .map((chat) => {
      const unread = chat.unread > 0 ? paint(` (${chat.unread} new)`, 'yellow', options) : ''
      const kind = chat.isGroup ? paint('group', 'cyan', options) : 'direct'
      const name = chat.name ?? shortJid(chat.jid)
      return `${timestamp(chat.lastTs)}  ${name}${unread}\n    ${paint(chat.jid, 'dim', options)}  [${kind}]\n    ${chat.lastText}`
    })
    .join('\n\n')
}

export function renderMessages(
  messages: MessageRecord[],
  options: OutputOptions,
  names: Record<string, string> = {},
): string {
  if (messages.length === 0) return 'No messages.'

  return messages
    .map((message) => {
      const who = message.fromMe
        ? 'me'
        : message.fromName ?? names[message.from] ?? shortJid(message.from)
      const label = message.fromMe ? paint(who, 'green', options) : paint(who, 'cyan', options)
      const reply = message.replyTo ? paint(' (reply)', 'dim', options) : ''
      return `${paint(timestamp(message.ts), 'dim', options)} ${label}${reply}\n  ${message.text}`
    })
    .join('\n')
}

/** One-line form used by `watch` in text mode. */
export function renderMessageLine(
  message: MessageRecord,
  options: OutputOptions,
): string {
  const who = message.fromMe ? 'me' : message.fromName ?? shortJid(message.from)
  return `${paint(timestamp(message.ts), 'dim', options)} ${paint(who, 'cyan', options)}: ${message.text}`
}

export function renderSendResult(result: {
  messageId: string
  chat: string
  timestamp: number
}): string {
  return `Sent to ${result.chat} (id ${result.messageId})`
}
