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

test('setGroupName tracks group subject and registers chat', async () => {
  const { store } = makeStore()
  store.setGroupName('120363@g.us', 'Engineers Lounge')
  const chats = store.listChats()
  assert.equal(chats.length, 1)
  assert.equal(chats[0]!.jid, '120363@g.us')
  assert.equal(chats[0]!.name, 'Engineers Lounge')
  assert.equal(chats[0]!.isGroup, true)
  assert.equal(store.contactName('120363@g.us'), 'Engineers Lounge')
})

test('setContact prioritizes full name over notify pushName', async () => {
  const { store } = makeStore()
  // First notify arrives
  store.setContact('628555@s.whatsapp.net', { notify: 'Budi' })
  assert.equal(store.contactName('628555@s.whatsapp.net'), 'Budi')

  // Address book full name arrives later
  store.setContact('628555@s.whatsapp.net', { fullName: 'Budi Santoso' })
  assert.equal(store.contactName('628555@s.whatsapp.net'), 'Budi Santoso')

  // Another pushName arrives later; full name must still win
  store.setContact('628555@s.whatsapp.net', { notify: 'Bud' })
  assert.equal(store.contactName('628555@s.whatsapp.net'), 'Budi Santoso')
})

test('touchChat registers a chat even before messages arrive', async () => {
  const { store } = makeStore()
  store.touchChat('628999@s.whatsapp.net', { name: 'Alice', unread: 3 })
  const chats = store.listChats()
  assert.equal(chats.length, 1)
  assert.equal(chats[0]!.name, 'Alice')
  assert.equal(chats[0]!.unread, 3)
})

test('listContacts filters by name and phone', async () => {
  const { store } = makeStore()
  store.setContact('62812345@s.whatsapp.net', { fullName: 'Charlie Brown' })
  store.setContact('62899999@s.whatsapp.net', { notify: 'Dave' })

  const all = store.listContacts()
  assert.equal(all.length, 2)
  const charlie = store.listContacts({ search: 'charlie' })
  assert.equal(charlie.length, 1)
  assert.equal(charlie[0]!.name, 'Charlie Brown')
  const byPhone = store.listContacts({ search: '899999' })
  assert.equal(byPhone.length, 1)
  assert.equal(byPhone[0]!.notify, 'Dave')
})

test('hides status broadcasts and protocol-only records', async () => {
  const { store } = makeStore()
  store.append(record({ id: 'status', chat: 'status@broadcast', type: 'unknown', text: '[unknown]' }))
  store.append(record({ id: 'sys', type: 'protocolMessage', text: '[system]' }))
  store.append(record({ id: 'keys', type: 'senderKeyDistributionMessage', text: '[keys]' }))
  store.append(record({ id: 'real', text: 'real message' }))

  const chats = store.listChats()
  assert.equal(chats.length, 1)
  assert.equal(chats[0]!.jid, '628111@s.whatsapp.net')

  const messages = await store.messages({})
  assert.deepEqual(
    messages.map((m) => m.id),
    ['real'],
  )

  const found = await store.search('unknown')
  assert.equal(found.length, 0)
})

test('links a LID and a phone number into one chat with unified messages', async () => {
  const { store } = makeStore()
  store.append(record({ id: 'a', chat: '111@lid', chatName: null, from: '111@lid', fromName: 'derila', ts: 100 }))
  store.append(
    record({
      id: 'b',
      chat: '628111@s.whatsapp.net',
      chatName: null,
      from: '628111@s.whatsapp.net',
      ts: 200,
      text: 'phone msg',
    }),
  )
  assert.equal(store.listChats().length, 2)

  store.linkJids(['111@lid', '628111@s.whatsapp.net'])

  const chats = store.listChats()
  assert.equal(chats.length, 1)
  assert.equal(chats[0]!.jid, '628111@s.whatsapp.net')
  assert.equal(chats[0]!.lastText, 'phone msg')
  assert.equal(store.canonicalJid('111@lid'), '628111@s.whatsapp.net')
  assert.deepEqual(store.jidVariants('111@lid').sort(), ['111@lid', '628111@s.whatsapp.net'])

  assert.equal((await store.messages({ chat: '628111@s.whatsapp.net' })).length, 2)
  // Looking the chat up by either identity returns the same conversation.
  assert.deepEqual(
    (await store.messages({ chat: '111@lid' })).map((m) => m.id),
    ['a', 'b'],
  )
})

test('merging identities keeps the known name and sums unread', () => {
  const { store } = makeStore()
  store.setContact('111@lid', { fullName: 'derila' })
  store.append(record({ id: 'x', chat: '111@lid', chatName: null, from: '111@lid', ts: 100 }))
  store.append(
    record({ id: 'y', chat: '628111@s.whatsapp.net', chatName: null, from: '628111@s.whatsapp.net', ts: 200 }),
  )

  store.linkJids(['111@lid', '628111@s.whatsapp.net'])

  const chat = store.listChats()[0]!
  assert.equal(chat.name, 'derila')
  assert.equal(chat.unread, 2)
  assert.equal(store.contactName('628111@s.whatsapp.net'), 'derila')
})

test('persists identity aliases across a reload', async () => {
  const first = makeStore()
  first.store.append(record({ id: 'a', chat: '111@lid', from: '111@lid', chatName: 'derila', ts: 100 }))
  first.store.append(record({ id: 'b', chat: '628111@s.whatsapp.net', from: '628111@s.whatsapp.net', ts: 200 }))
  first.store.linkJids(['111@lid', '628111@s.whatsapp.net'])
  first.store.flushSnapshot()

  const reloaded = new Store(first.messagesFile, first.chatsFile)
  await reloaded.load()

  assert.equal(reloaded.listChats().length, 1)
  assert.equal(reloaded.canonicalJid('111@lid'), '628111@s.whatsapp.net')
  assert.equal((await reloaded.messages({ chat: '111@lid' })).length, 2)
})

test('directPhoneJids lists only unlinked phone-number chats', () => {
  const { store } = makeStore()
  store.touchChat('628111@s.whatsapp.net', { name: 'Alice' })
  store.touchChat('111@lid', { name: 'Bob' })
  store.touchChat('120363@g.us', { name: 'Group' })
  store.touchChat('628999@s.whatsapp.net', { name: 'Carol' })
  assert.deepEqual(store.directPhoneJids().sort(), ['628111@s.whatsapp.net', '628999@s.whatsapp.net'])

  // Once an identity is linked it is no longer a lookup candidate.
  store.linkJids(['628111@s.whatsapp.net', '111@lid'])
  assert.deepEqual(store.directPhoneJids(), ['628999@s.whatsapp.net'])
})

test('listContacts hides anonymous LID group-member entries', () => {
  const { store } = makeStore()
  store.setContact('111@lid', { fullName: null, notify: null })
  store.setContact('628222@s.whatsapp.net', { fullName: null, notify: null })
  store.setContact('222@lid', { fullName: 'Named LID' })

  const jids = store.listContacts().map((c) => c.jid)
  assert.ok(!jids.includes('111@lid'))
  assert.ok(jids.includes('628222@s.whatsapp.net'))
  assert.ok(jids.includes('222@lid'))
})

test('hides our own self-chat from the chat list', () => {
  const { store } = makeStore()
  store.touchChat('6285156176098@s.whatsapp.net', {})
  store.touchChat('111@lid', { name: 'Self LID' })
  store.linkJids(['6285156176098@s.whatsapp.net', '111@lid'])
  store.touchChat('628999@s.whatsapp.net', { name: 'Friend' })

  store.setSelfJid('111@lid')

  const jids = store.listChats().map((c) => c.jid)
  assert.ok(!jids.includes('6285156176098@s.whatsapp.net'))
  assert.ok(jids.includes('628999@s.whatsapp.net'))
})
