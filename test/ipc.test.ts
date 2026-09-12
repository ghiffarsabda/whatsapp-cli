import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { AppError } from '../src/shared/errors.js'
import type { EventFrame, MessageRecord } from '../src/shared/protocol.js'
import { IpcServer } from '../src/daemon/ipc-server.js'
import { call, probe, subscribe } from '../src/cli/ipc-client.js'

const dir = mkdtempSync(join(tmpdir(), 'wa-ipc-'))
const socketPath = join(dir, 'daemon.sock')

let server: IpcServer

before(async () => {
  server = new IpcServer(socketPath, {
    status: async () => ({ connection: 'open', loggedIn: true }),
    read: async (params) => ({ echo: params.chat, messages: [] }),
    send: async (params) => {
      if (params.chat === 'nowhere') throw new AppError('not_found', 'no such chat')
      return { messageId: 'MSG1', chat: params.chat, timestamp: 1 }
    },
    subscribe: async (params, context) => {
      const sub = context.registerSubscription(
        typeof params.chat === 'string' ? params.chat : null,
      )
      return { sub, chat: params.chat ?? null }
    },
  })
  await server.start()
})

after(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('probe detects a listening daemon', async () => {
  assert.equal(await probe(socketPath, 1000), true)
  assert.equal(await probe(join(dir, 'missing.sock'), 200), false)
})

test('round-trips a request and response', async () => {
  const result = await call<{ connection: string }>('status', {}, { socketPath })
  assert.deepEqual(result, { connection: 'open', loggedIn: true })
})

test('passes parameters through', async () => {
  const result = await call<{ echo: string }>('read', { chat: 'budi' }, { socketPath })
  assert.equal(result.echo, 'budi')
})

test('daemon-side AppError codes survive the round trip', async () => {
  await assert.rejects(
    () => call('send', { chat: 'nowhere' }, { socketPath }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'not_found')
      assert.equal(error.exitCode, 5)
      return true
    },
  )
})

test('unknown methods are reported as usage errors', async () => {
  await assert.rejects(
    // Deliberately bypassing the Method union to exercise the server guard.
    () => call('nope' as never, {}, { socketPath }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'usage')
      return true
    },
  )
})

test('a connection error is reported as daemon_unreachable', async () => {
  await assert.rejects(
    () => call('status', {}, { socketPath: join(dir, 'missing.sock'), timeoutMs: 500 }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'daemon_unreachable')
      assert.equal(error.exitCode, 4)
      return true
    },
  )
})

test('subscriptions receive broadcast messages, filtered by chat', async () => {
  const received: MessageRecord[] = []
  const all: EventFrame[] = []

  const subscription = await subscribe(null, (frame) => all.push(frame), { socketPath })
  const scoped = await subscribe('628111@s.whatsapp.net', (frame) => {
    if (frame.event === 'message') received.push(frame.data as MessageRecord)
  }, { socketPath })

  // Give the server a moment to register both subscriptions.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(server.subscriberCount, 2)

  const budi = {
    id: 'x1',
    chat: '628111@s.whatsapp.net',
    chatName: 'Budi',
    from: '628111@s.whatsapp.net',
    fromName: 'Budi',
    fromMe: false,
    ts: 1,
    type: 'text',
    text: 'hello',
  } satisfies MessageRecord
  server.broadcastMessage(budi)
  server.broadcastMessage({ ...budi, id: 'x2', chat: '628222@s.whatsapp.net' })

  await new Promise((resolve) => setTimeout(resolve, 150))

  // The unfiltered subscriber sees both; the scoped one only its chat.
  assert.equal(all.length, 2)
  assert.equal(received.length, 1)
  assert.equal(received[0]!.id, 'x1')

  subscription.close()
  scoped.close()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(server.subscriberCount, 0)
})

test('status broadcasts reach subscribers', async () => {
  const frames: EventFrame[] = []
  const subscription = await subscribe(null, (frame) => frames.push(frame), { socketPath })
  await new Promise((resolve) => setTimeout(resolve, 100))

  server.broadcastStatus({ connection: 'open' })
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.event, 'status')
  subscription.close()
})
