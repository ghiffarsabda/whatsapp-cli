import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { IpcServer } from '../src/daemon/ipc-server.js'
import { buildHandlers } from '../src/daemon/methods.js'
import { Store } from '../src/daemon/store.js'
import { call } from '../src/cli/ipc-client.js'
import { osc8Hyperlink } from '../src/shared/media-player.js'
import { renderContacts } from '../src/cli/render.js'
import type { WaConnection } from '../src/daemon/baileys.js'
import type { ContactSummary, MessageRecord } from '../src/shared/protocol.js'

const dir = mkdtempSync(join(tmpdir(), 'wa-media-test-'))
const socketPath = join(dir, 'daemon.sock')
const messagesFile = join(dir, 'messages.jsonl')
const snapshotPath = join(dir, 'snapshot.json')
const mediaDir = join(dir, 'media')

// Create a dummy file for media upload testing
const testFile = join(dir, 'test-doc.pdf')
writeFileSync(testFile, 'dummy pdf content')

let server: IpcServer
let store: Store

const sentMediaCalls: Array<{
  chat: string
  filePath: string
  type?: string
  caption?: string
  fileName?: string
}> = []

const sentTextCalls: Array<{ chat: string; text: string }> = []
let syncGroupsCalled = 0

const mockConnection = {
  getState: () => ({ connection: 'open', loggedIn: true }),
  waitForOpen: async () => {},
  syncGroups: async () => {
    syncGroupsCalled++
  },
  sendText: async (chat: string, text: string) => {
    sentTextCalls.push({ chat, text })
    return {
      messageId: 'mock-text-id',
      chat,
      timestamp: Math.floor(Date.now() / 1000),
    }
  },
  sendMedia: async (
    chat: string,
    filePath: string,
    options: {
      type?: 'image' | 'voice' | 'audio' | 'document'
      caption?: string
      fileName?: string
    } = {},
  ) => {
    sentMediaCalls.push({
      chat,
      filePath,
      type: options.type,
      caption: options.caption,
      fileName: options.fileName,
    })
    return {
      messageId: 'mock-media-id',
      chat,
      timestamp: Math.floor(Date.now() / 1000),
    }
  },
} as unknown as WaConnection

before(async () => {
  store = new Store(messagesFile, snapshotPath)
  await store.load()

  // Prepopulate store with test contacts and chats
  store.setContact('628111111111@s.whatsapp.net', {
    fullName: 'Alexander Graham Bell',
    notify: 'Alex',
  })
  store.setGroupName('120363000000@g.us', 'Alpha Engineering Team')

  const handlers = buildHandlers({
    store,
    connection: mockConnection,
    requestShutdown: () => {},
    subscriberCount: () => 0,
    resolveMedia: (chat, messageId) => {
      const safe = chat.replace(/[^a-zA-Z0-9_-]/g, '_')
      const dir = join(mediaDir, safe)
      if (!existsSync(dir)) return null
      const match = readdirSync(dir).find((name) => name.startsWith(`${messageId}.`))
      return match ? join(dir, match) : null
    },
  })

  server = new IpcServer(socketPath, handlers)
  await server.start()
})

after(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('osc8Hyperlink generates terminal hyperlink ANSI sequence', () => {
  const link = osc8Hyperlink('file:///tmp/image.png', 'View Image')
  assert.equal(link, '\u001B]8;;file:///tmp/image.png\u0007View Image\u001B]8;;\u0007')
})

test('renderContacts outputs formatted table with names and JIDs', () => {
  const contacts: ContactSummary[] = [
    {
      jid: '628111@s.whatsapp.net',
      name: 'Jane Doe',
      notify: 'Jane',
      phone: '628111',
      isGroup: false,
    },
    {
      jid: '120363@g.us',
      name: 'Project Discussion',
      notify: null,
      phone: null,
      isGroup: true,
    },
  ]
  const rendered = renderContacts(contacts, { color: false, quiet: false, format: 'text' })
  assert.match(rendered, /Jane Doe/)
  assert.match(rendered, /Project Discussion/)
  assert.match(rendered, /direct/)
  assert.match(rendered, /group/)
})

test('IPC contacts method lists stored contacts with search filtering', async () => {
  const resAll = await call<{ contacts: ContactSummary[] }>('contacts', {}, { socketPath })
  assert.ok(resAll.contacts.length >= 2)

  const resSearch = await call<{ contacts: ContactSummary[] }>(
    'contacts',
    { search: 'Graham' },
    { socketPath },
  )
  assert.equal(resSearch.contacts.length, 1)
  assert.equal(resSearch.contacts[0]?.name, 'Alexander Graham Bell')
})

test('IPC sync method triggers group sync on connection', async () => {
  const initialCount = syncGroupsCalled
  const res = await call<{ ok: boolean; chatCount: number }>('sync', {}, { socketPath })
  assert.equal(res.ok, true)
  assert.equal(syncGroupsCalled, initialCount + 1)
})

test('IPC sendMedia method delegates to connection with correct params', async () => {
  const result = await call<{ messageId: string; chat: string }>(
    'sendMedia',
    {
      chat: 'Alexander',
      path: testFile,
      type: 'document',
      caption: 'Spec document',
      fileName: 'spec.pdf',
    },
    { socketPath },
  )

  assert.equal(result.messageId, 'mock-media-id')
  assert.equal(sentMediaCalls.length, 1)
  const last = sentMediaCalls[0]!
  assert.equal(last.chat, '628111111111@s.whatsapp.net')
  assert.equal(last.filePath, testFile)
  assert.equal(last.type, 'document')
  assert.equal(last.caption, 'Spec document')
  assert.equal(last.fileName, 'spec.pdf')
})

test('IPC send intercepts @document syntax', async () => {
  await call(
    'send',
    {
      chat: '628111111111@s.whatsapp.net',
      text: `@document ${testFile} Project Roadmap`,
    },
    { socketPath },
  )

  const last = sentMediaCalls[sentMediaCalls.length - 1]!
  assert.equal(last.type, 'document')
  assert.equal(last.filePath, testFile)
  assert.equal(last.caption, 'Project Roadmap')
})

test('IPC send intercepts @voice syntax', async () => {
  await call(
    'send',
    {
      chat: '628111111111@s.whatsapp.net',
      text: `@voice ${testFile}`,
    },
    { socketPath },
  )

  const last = sentMediaCalls[sentMediaCalls.length - 1]!
  assert.equal(last.type, 'voice')
  assert.equal(last.filePath, testFile)
})

test('IPC send intercepts @image syntax', async () => {
  await call(
    'send',
    {
      chat: '628111111111@s.whatsapp.net',
      text: `@image ${testFile} Photo Caption`,
    },
    { socketPath },
  )

  const last = sentMediaCalls[sentMediaCalls.length - 1]!
  assert.equal(last.type, 'image')
  assert.equal(last.filePath, testFile)
  assert.equal(last.caption, 'Photo Caption')
})

test('IPC read backfills a mediaPath for an already-downloaded file', async () => {
  const jid = '628777000000@s.whatsapp.net'
  store.setContact(jid, { fullName: 'Doc Sender' })
  store.append({
    id: 'DOCMSG',
    chat: jid,
    chatName: 'Doc Sender',
    from: jid,
    fromName: 'Doc Sender',
    fromMe: false,
    ts: 1700000100,
    type: 'documentMessage',
    text: '[document: old.pdf]',
    replyTo: null,
    mediaPath: null,
  })

  const safe = jid.replace(/[^a-zA-Z0-9_-]/g, '_')
  mkdirSync(join(mediaDir, safe), { recursive: true })
  const filePath = join(mediaDir, safe, 'DOCMSG.pdf')
  writeFileSync(filePath, 'pdf bytes')

  const res = await call<{ messages: MessageRecord[] }>(
    'read',
    { chat: jid, limit: 10 },
    { socketPath },
  )
  assert.equal(res.messages.length, 1)
  assert.equal(res.messages[0]!.mediaPath, filePath)
})
