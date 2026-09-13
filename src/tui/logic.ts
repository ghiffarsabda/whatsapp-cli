import type { ChatSummary, MessageRecord } from '../shared/protocol.js'
import { isGroupJid } from '../shared/jid.js'
import type { Pane } from './keys.js'

/** Newest messages kept in memory per chat. Older pages are dropped as they scroll off. */
export const MESSAGE_CAP = 300

/** Same de-duplication key the daemon uses, so re-delivered messages collapse. */
export function messageKey(record: Pick<MessageRecord, 'chat' | 'id'>): string {
  return `${record.chat}\u0000${record.id}`
}

function byTimestamp(a: MessageRecord, b: MessageRecord): number {
  return a.ts - b.ts
}

/**
 * Merge new messages into an existing list: de-duplicate by key, sort oldest
 * first, and keep the newest `cap` entries.
 */
export function mergeMessages(
  existing: MessageRecord[],
  incoming: MessageRecord[],
  cap = MESSAGE_CAP,
): MessageRecord[] {
  if (incoming.length === 0) return existing

  const byKey = new Map<string, MessageRecord>()
  for (const record of existing) byKey.set(messageKey(record), record)
  for (const record of incoming) byKey.set(messageKey(record), record)

  const merged = [...byKey.values()].sort(byTimestamp)
  return merged.length > cap ? merged.slice(merged.length - cap) : merged
}

/** Keep a scroll offset inside the valid range. */
export function clampOffset(offset: number, maxOffset: number): number {
  if (!Number.isFinite(offset)) return 0
  return Math.min(Math.max(Math.trunc(offset), 0), Math.max(0, maxOffset))
}

export interface MessageWindow {
  items: MessageRecord[]
  offset: number
  maxOffset: number
  atNewest: boolean
  hiddenOlder: number
}

/**
 * The slice of messages to draw.
 *
 * `offset` counts messages scrolled back from the newest (0 = pinned to the
 * bottom). The rendered slice is generous — one row per message minimum — and
 * the pane is bottom-aligned with overflow hidden, so tall messages clip from
 * the top instead of pushing the newest message out of view.
 */
export function visibleWindow(
  messages: MessageRecord[],
  offset: number,
  height: number,
): MessageWindow {
  // Cap at length - 1 so scrolling back always leaves something on screen.
  const maxOffset = Math.max(0, messages.length - 1)
  const clamped = clampOffset(offset, maxOffset)
  const end = messages.length - clamped
  const start = Math.max(0, end - Math.max(1, Math.trunc(height)))

  return {
    items: messages.slice(start, end),
    offset: clamped,
    maxOffset,
    atNewest: clamped === 0,
    hiddenOlder: start,
  }
}

/** Move a list selection by `delta`, wrapping at both ends. */
export function moveSelection(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isFinite(index)) return 0
  const next = (Math.trunc(index) + delta) % count
  return next < 0 ? next + count : next
}

/** Rough number of terminal rows a message will occupy when wrapped at `width`. */
export function estimateMessageHeight(message: MessageRecord, width: number): number {
  const inner = Math.max(1, width - 2)
  const text = (message.text ?? '').replace(/\s+/g, ' ').trim()
  const textRows = Math.min(8, Math.max(1, Math.ceil(text.length / inner)))
  const mediaRows = message.mediaPath ? 1 : 0
  return 1 + textRows + mediaRows
}

/**
 * Trim a window to the newest messages whose estimated heights fit `height`
 * rows. Rendering only what fits keeps the pane from overflowing (and visually
 * glitching) when a long message arrives. Always keeps at least one message.
 */
export function fitMessages(
  messages: MessageRecord[],
  height: number,
  width: number,
): MessageRecord[] {
  const budget = Math.max(1, Math.trunc(height))
  let used = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const rows = estimateMessageHeight(messages[i]!, width)
    if (used + rows > budget && start < messages.length) break
    used += rows
    start = i
  }
  return messages.slice(start)
}

/** Chat list ordering: most recent activity first. */
export function sortChats(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => b.lastTs - a.lastTs)
}

/**
 * Fold a live message into the chat list.
 *
 * Unread only increments when the message is inbound and belongs to a chat the
 * user is not currently looking at.
 */
export function applyIncomingChat(
  chats: ChatSummary[],
  record: MessageRecord,
  openChatJid: string | null,
): ChatSummary[] {
  const index = chats.findIndex((chat) => chat.jid === record.chat)
  const isOpen = openChatJid === record.chat

  if (index === -1) {
    const created: ChatSummary = {
      jid: record.chat,
      name: record.chatName,
      isGroup: isGroupJid(record.chat),
      lastTs: record.ts,
      lastText: record.text,
      unread: isOpen || record.fromMe ? 0 : 1,
    }
    return sortChats([created, ...chats])
  }

  const updated: ChatSummary = {
    ...chats[index],
    name: chats[index].name ?? record.chatName,
    lastTs: Math.max(chats[index].lastTs, record.ts),
    lastText: record.ts >= chats[index].lastTs ? record.text : chats[index].lastText,
    unread: isOpen || record.fromMe ? chats[index].unread : chats[index].unread + 1,
  }

  return sortChats(chats.map((chat, i) => (i === index ? updated : chat)))
}

/** Clear a chat's unread count, e.g. once it has been opened and marked read. */
export function clearUnread(chats: ChatSummary[], jid: string): ChatSummary[] {
  const index = chats.findIndex((chat) => chat.jid === jid)
  if (index === -1 || chats[index].unread === 0) return chats
  return chats.map((chat, i) => (i === index ? { ...chat, unread: 0 } : chat))
}

export function unreadTotal(chats: ChatSummary[]): number {
  return chats.reduce((sum, chat) => sum + Math.max(0, chat.unread), 0)
}

/** Index of a chat by jid, or 0 when absent. */
export function indexOfChat(chats: ChatSummary[], jid: string | null): number {
  if (jid === null) return 0
  const index = chats.findIndex((chat) => chat.jid === jid)
  return index === -1 ? 0 : index
}

/** One-line preview for a chat row, collapsed and length-bounded. */
export function previewText(text: string, max = 40): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`
}

/** Timestamp for a chat row or message header, as HH:MM or a date when older. */
export function shortTime(seconds: number, now = Date.now()): string {
  const date = new Date(seconds * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const sameDay = new Date(now).toDateString() === date.toDateString()
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Display name for a chat or message sender. */
export function displayName(jid: string, name?: string | null): string {
  if (name && name.trim() !== '') return name
  const [local] = jid.split('@')
  return local ?? jid
}

/**
 * Tab toggles between the chat list and the open chat room. It never focuses
 * the composer (that is `i`), and with no chat open it stays on the list.
 */
export function nextPane(pane: Pane, hasOpenChat: boolean): Pane {
  if (pane === 'list') return hasOpenChat ? 'messages' : 'list'
  return 'list'
}
