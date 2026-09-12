import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatSummary, MessageRecord } from '../src/shared/protocol.js'
import {
  applyIncomingChat,
  clampOffset,
  clearUnread,
  displayName,
  indexOfChat,
  mergeMessages,
  moveSelection,
  previewText,
  shortTime,
  sortChats,
  unreadTotal,
  visibleWindow,
} from '../src/tui/logic.js'

function msg(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 'm1',
    chat: '628111@s.whatsapp.net',
    chatName: 'Budi',
    from: '628111@s.whatsapp.net',
    fromName: 'Budi',
    fromMe: false,
    ts: 1000,
    type: 'text',
    text: 'hello',
    replyTo: null,
    ...overrides,
  }
}

function chat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    jid: '628111@s.whatsapp.net',
    name: 'Budi',
    isGroup: false,
    lastTs: 1000,
    lastText: 'hello',
    unread: 0,
    ...overrides,
  }
}

test('mergeMessages de-duplicates by chat and id', () => {
  const existing = [msg({ id: 'a', ts: 1 })]
  const merged = mergeMessages(existing, [msg({ id: 'a', ts: 1, text: 'updated' })])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.text, 'updated')
})

test('mergeMessages sorts oldest first', () => {
  const merged = mergeMessages(
    [msg({ id: 'c', ts: 30 })],
    [msg({ id: 'a', ts: 10 }), msg({ id: 'b', ts: 20 })],
  )
  assert.deepEqual(
    merged.map((m) => m.id),
    ['a', 'b', 'c'],
  )
})

test('mergeMessages keeps only the newest entries past the cap', () => {
  const incoming = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}`, ts: i }))
  const merged = mergeMessages([], incoming, 3)
  assert.deepEqual(
    merged.map((m) => m.id),
    ['m7', 'm8', 'm9'],
  )
})

test('mergeMessages is a no-op for empty input', () => {
  const existing = [msg()]
  assert.equal(mergeMessages(existing, []), existing)
})

test('mergeMessages dedupes the same message id across different chats', () => {
  const merged = mergeMessages(
    [msg({ id: 'x', chat: 'a@s.whatsapp.net' })],
    [msg({ id: 'x', chat: 'b@s.whatsapp.net' })],
  )
  assert.equal(merged.length, 2)
})

test('clampOffset bounds the scroll position', () => {
  assert.equal(clampOffset(-5, 10), 0)
  assert.equal(clampOffset(5, 10), 5)
  assert.equal(clampOffset(50, 10), 10)
  assert.equal(clampOffset(Number.NaN, 10), 0)
})

test('visibleWindow pins to the newest messages at offset 0', () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}`, ts: i }))
  const window = visibleWindow(messages, 0, 3)
  assert.deepEqual(
    window.items.map((m) => m.id),
    ['m7', 'm8', 'm9'],
  )
  assert.equal(window.atNewest, true)
  assert.equal(window.hiddenOlder, 7)
})

test('visibleWindow scrolls back through history', () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}`, ts: i }))
  const window = visibleWindow(messages, 4, 3)
  // Offset 4 means "the newest 4 are below the viewport".
  assert.deepEqual(
    window.items.map((m) => m.id),
    ['m3', 'm4', 'm5'],
  )
  assert.equal(window.atNewest, false)
})

test('visibleWindow clamps an over-scrolled offset', () => {
  const messages = [msg({ id: 'a', ts: 1 }), msg({ id: 'b', ts: 2 })]
  const window = visibleWindow(messages, 999, 5)
  // Two messages means at most one can be hidden below; the oldest stays visible.
  assert.equal(window.offset, 1)
  assert.equal(window.maxOffset, 1)
  assert.equal(window.atNewest, false)
  assert.equal(window.items.length, 1)
  assert.equal(window.items[0]!.id, 'a')
})

test('visibleWindow copes with an empty chat', () => {
  const window = visibleWindow([], 0, 10)
  assert.deepEqual(window.items, [])
  assert.equal(window.atNewest, true)
  assert.equal(window.maxOffset, 0)
})

test('moveSelection wraps at both ends', () => {
  assert.equal(moveSelection(0, 1, 3), 1)
  assert.equal(moveSelection(2, 1, 3), 0)
  assert.equal(moveSelection(0, -1, 3), 2)
  assert.equal(moveSelection(1, 0, 3), 1)
})

test('moveSelection is safe with an empty list', () => {
  assert.equal(moveSelection(0, 1, 0), 0)
})

test('sortChats puts the most recent first', () => {
  const sorted = sortChats([
    chat({ jid: 'a', lastTs: 10 }),
    chat({ jid: 'b', lastTs: 30 }),
    chat({ jid: 'c', lastTs: 20 }),
  ])
  assert.deepEqual(
    sorted.map((c) => c.jid),
    ['b', 'c', 'a'],
  )
})

test('applyIncomingChat increments unread for a non-open chat', () => {
  const chats = [chat({ jid: 'a' }), chat({ jid: 'b' })]
  const next = applyIncomingChat(chats, msg({ chat: 'b', ts: 2000, text: 'new' }), 'a')
  assert.equal(next.find((c) => c.jid === 'b')!.unread, 1)
  assert.equal(next.find((c) => c.jid === 'b')!.lastText, 'new')
})

test('applyIncomingChat does not increment unread for the open chat', () => {
  const chats = [chat({ jid: 'a' })]
  const next = applyIncomingChat(chats, msg({ chat: 'a', ts: 2000 }), 'a')
  assert.equal(next[0]!.unread, 0)
})

test('applyIncomingChat never counts your own messages as unread', () => {
  const next = applyIncomingChat([], msg({ chat: 'z', fromMe: true, ts: 5 }), null)
  assert.equal(next[0]!.unread, 0)
})

test('applyIncomingChat inserts a previously unknown chat and re-sorts', () => {
  const chats = [chat({ jid: 'a', lastTs: 100 })]
  const next = applyIncomingChat(chats, msg({ chat: 'z', ts: 500, chatName: 'Zed' }), 'a')
  assert.equal(next.length, 2)
  assert.equal(next[0]!.jid, 'z')
  assert.equal(next[0]!.name, 'Zed')
})

test('applyIncomingChat moves the updated chat to the top', () => {
  const chats = [chat({ jid: 'a', lastTs: 100 }), chat({ jid: 'b', lastTs: 50 })]
  const next = applyIncomingChat(chats, msg({ chat: 'b', ts: 900 }), 'a')
  assert.equal(next[0]!.jid, 'b')
})

test('applyIncomingChat keeps lastText of the newest message only', () => {
  const chats = [chat({ jid: 'a', lastTs: 500, lastText: 'newest' })]
  const next = applyIncomingChat(chats, msg({ chat: 'a', ts: 100, text: 'older' }), 'a')
  assert.equal(next[0]!.lastText, 'newest')
  assert.equal(next[0]!.lastTs, 500)
})

test('clearUnread resets a single chat', () => {
  const chats = [chat({ jid: 'a', unread: 3 }), chat({ jid: 'b', unread: 2 })]
  const next = clearUnread(chats, 'a')
  assert.equal(next.find((c) => c.jid === 'a')!.unread, 0)
  assert.equal(next.find((c) => c.jid === 'b')!.unread, 2)
})

test('clearUnread returns the same array when nothing changes', () => {
  const chats = [chat({ jid: 'a', unread: 0 })]
  assert.equal(clearUnread(chats, 'a'), chats)
  assert.equal(clearUnread(chats, 'missing'), chats)
})

test('unreadTotal sums the badges', () => {
  assert.equal(unreadTotal([chat({ unread: 2 }), chat({ unread: 3 })]), 5)
  assert.equal(unreadTotal([]), 0)
})

test('indexOfChat finds a jid and defaults safely', () => {
  const chats = [chat({ jid: 'a' }), chat({ jid: 'b' })]
  assert.equal(indexOfChat(chats, 'b'), 1)
  assert.equal(indexOfChat(chats, 'nope'), 0)
  assert.equal(indexOfChat(chats, null), 0)
})

test('previewText collapses whitespace and truncates', () => {
  assert.equal(previewText('  hello   world  '), 'hello world')
  assert.equal(previewText('abcdefghij', 5), 'abcd…')
})

test('shortTime shows a clock time for today and a date otherwise', () => {
  const now = new Date('2026-09-12T10:00:00Z').getTime()
  const today = new Date('2026-09-12T08:30:00Z').getTime() / 1000
  const older = new Date('2026-09-01T08:30:00Z').getTime() / 1000
  assert.match(shortTime(today, now), /^\d{2}:\d{2}$/)
  assert.match(shortTime(older, now), /^\d{2}\/\d{2} \d{2}:\d{2}$/)
})

test('displayName falls back to the jid local part', () => {
  assert.equal(displayName('628111@s.whatsapp.net', 'Budi'), 'Budi')
  assert.equal(displayName('628111@s.whatsapp.net', null), '628111')
  assert.equal(displayName('628111@s.whatsapp.net', '   '), '628111')
})
