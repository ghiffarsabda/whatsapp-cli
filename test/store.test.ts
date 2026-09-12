import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { MessageRecord } from '../src/shared/protocol.js'
import { Store } from '../src/daemon/store.js'

const dirs: string[] = []

function makeStore(): { store: Store; dir: string; messagesFile: string; chatsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wa-store-'))
  dirs.push(dir)
  const messagesFile = join(dir, 'messages.jsonl')
  const chatsFile = join(dir, 'chats.json')
  return { store: new Store(messagesFile, chatsFile), dir, messagesFile, chatsFile }
}

function record(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 'm1',
    chat: '628111@s.whatsapp.net',
    chatName: 'Budi',
    from: '628111@s.whatsapp.net',
    fromName: 'Budi',
    fromMe: false,
    ts: 1700000000,
    type: 'text',
    text: 'hello',
    replyTo: null,
    ...overrides,
  }
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test('appends one JSON object per line', async () => {
  const { store, messagesFile } = makeStore()
  store.append(record({ id: 'a', text: 'first' }))
  store.append(record({ id: 'b', text: 'second' }))

  const lines = readFileSync(messagesFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]!).text, 'first')
  assert.equal(JSON.parse(lines[1]!).text, 'second')
})

test('dedupes re-delivered messages', async () => {
  const { store, messagesFile } = makeStore()
  assert.equal(store.append(record({ id: 'dup' })), true)
  assert.equal(store.append(record({ id: 'dup' })), false)

  const lines = readFileSync(messagesFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
})

test('tolerates a truncated trailing line', async () => {
  const { store, messagesFile } = makeStore()
  store.append(record({ id: 'good', text: 'complete' }))
  const { appendFileSync } = await import('node:fs')
  appendFileSync(messagesFile, '{"id":"broken","chat":"628111@s.wha')

  const messages = await store.messages({})
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.text, 'complete')
})

test('derives the chat index from the log on load', async () => {
  const first = makeStore()
  first.store.append(record({ id: 'a', ts: 100, text: 'old' }))
  first.store.append(record({ id: 'b', ts: 200, text: 'new' }))
  first.store.append(record({ id: 'c', chat: '628222@s.whatsapp.net', chatName: 'Ani', ts: 150, text: 'other' }))

  const reloaded = new Store(first.messagesFile, first.chatsFile)
  await reloaded.load()

  const chats = reloaded.listChats()
  assert.equal(chats.length, 2)
  // Sorted by most recent activity.
  assert.equal(chats[0]!.jid, '628111@s.whatsapp.net')
  assert.equal(chats[0]!.lastTs, 200)
  assert.equal(chats[0]!.lastText, 'new')
  assert.equal(chats[1]!.jid, '628222@s.whatsapp.net')
})

test('recovers chat names from the log when no snapshot exists', async () => {
  const first = makeStore()
  first.store.append(record({ id: 'a', chatName: 'Budi' }))
  first.store.append(
    record({ id: 'b', chat: '120363@g.us', chatName: 'Team Standup' }),
  )

  // No flushSnapshot(): simulate a daemon restart with only the log on disk.
  const reloaded = new Store(first.messagesFile, first.chatsFile)
  await reloaded.load()

  const byJid = new Map(reloaded.listChats().map((chat) => [chat.jid, chat.name]))
  assert.equal(byJid.get('628111@s.whatsapp.net'), 'Budi')
  assert.equal(byJid.get('120363@g.us'), 'Team Standup')
})

test('a contacts snapshot outranks a name from the log', async () => {
  const first = makeStore()
  first.store.append(record({ id: 'a', chatName: 'Stale Name' }))
  first.store.setContactName('628111@s.whatsapp.net', 'Preferred Name')
  first.store.flushSnapshot()

  const reloaded = new Store(first.messagesFile, first.chatsFile)
  await reloaded.load()
  assert.equal(reloaded.listChats()[0]!.name, 'Preferred Name')
})

test('persists names and unread counts across restarts', async () => {
  const first = makeStore()
  first.store.setContactName('628111@s.whatsapp.net', 'Budi')
  first.store.append(record({ id: 'a' }))
  first.store.append(record({ id: 'b' }))
  first.store.flushSnapshot()

  const reloaded = new Store(first.messagesFile, first.chatsFile)
  await reloaded.load()
  assert.equal(reloaded.listChats()[0]!.unread, 2)
  assert.equal(reloaded.listChats()[0]!.name, 'Budi')

  reloaded.markRead('628111@s.whatsapp.net')
  reloaded.flushSnapshot()

  const third = new Store(first.messagesFile, first.chatsFile)
  await third.load()
  assert.equal(third.listChats()[0]!.unread, 0)
})

test('counts only inbound messages as unread', async () => {
  const { store } = makeStore()
  store.append(record({ id: 'in', fromMe: false }))
  store.append(record({ id: 'out', fromMe: true }))
  assert.equal(store.listChats()[0]!.unread, 1)
})

test('filters chat lists by unread and search', async () => {
  const { store } = makeStore()
  store.append(record({ id: 'a', chat: '628111@s.whatsapp.net', chatName: 'Budi' }))
  store.append(record({ id: 'b', chat: '628222@s.whatsapp.net', chatName: 'Ani', fromMe: true }))

  assert.equal(store.listChats({ unreadOnly: true }).length, 1)
  assert.equal(store.listChats({ unreadOnly: true })[0]!.jid, '628111@s.whatsapp.net')
  assert.equal(store.listChats({ search: 'ani' }).length, 1)
  assert.equal(store.listChats({ search: 'zzz' }).length, 0)
  assert.equal(store.listChats({ limit: 1 }).length, 1)
})

test('messages query honours chat, limit, and time bounds', async () => {
  const { store } = makeStore()
  for (let i = 0; i < 10; i += 1) {
    store.append(record({ id: `m${i}`, ts: 1000 + i, text: `msg ${i}` }))
  }
  store.append(record({ id: 'other', chat: '628222@s.whatsapp.net', ts: 2000, text: 'other chat' }))

  const all = await store.messages({ chat: '628111@s.whatsapp.net' })
  assert.equal(all.length, 10)

  const lastThree = await store.messages({ chat: '628111@s.whatsapp.net', limit: 3 })
  assert.deepEqual(
    lastThree.map((m) => m.text),
    ['msg 7', 'msg 8', 'msg 9'],
  )

  const since = await store.messages({ chat: '628111@s.whatsapp.net', since: 1005 })
  assert.equal(since.length, 5)

  const before = await store.messages({ chat: '628111@s.whatsapp.net', before: 1003 })
  assert.equal(before.length, 3)
})

test('search is case-insensitive and can be scoped to a chat', async () => {
  const { store } = makeStore()
  store.append(record({ id: 'a', text: 'Meeting at noon', ts: 1000 }))
  store.append(record({ id: 'b', text: 'lunch plans', ts: 1001 }))
  store.append(
    record({ id: 'c', chat: '628222@s.whatsapp.net', text: 'Meeting later', ts: 1002 }),
  )

  const all = await store.search('meeting')
  assert.equal(all.length, 2)
  // Newest first.
  assert.equal(all[0]!.id, 'c')

  const scoped = await store.search('meeting', { chat: '628111@s.whatsapp.net' })
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0]!.id, 'a')
})

test('exposes candidates for chat resolution', async () => {
  const { store } = makeStore()
  store.append(record({ id: 'a', chatName: 'Budi' }))
  const candidates = store.candidates()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.name, 'Budi')
  assert.equal(candidates[0]!.isGroup, false)
})

test('marks group chats as groups', async () => {
  const { store } = makeStore()
  store.append(record({ id: 'g', chat: '120363@g.us', chatName: 'Team' }))
  assert.equal(store.listChats()[0]!.isGroup, true)
})
