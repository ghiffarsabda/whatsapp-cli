import { chmodSync, existsSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { ensurePrivateDir } from '../shared/atomic.js'
import { toErrorPayload } from '../shared/errors.js'
import type { EventFrame, Request, Response } from '../shared/protocol.js'

export interface ConnectionContext {
  socket: Socket
  registerSubscription: (chat: string | null) => string
}

export type MethodHandler = (
  params: Record<string, unknown>,
  context: ConnectionContext,
) => Promise<unknown>

interface Subscription {
  socket: Socket
  chat: string | null
}

/** Newline-delimited JSON over a Unix domain socket. */
export class IpcServer {
  private server: Server | null = null
  private readonly subscriptions = new Map<string, Subscription>()
  private subscriptionSeq = 0

  constructor(
    private readonly socketPath: string,
    private readonly handlers: Record<string, MethodHandler>,
  ) {}

  async start(): Promise<void> {
    ensurePrivateDir(dirname(this.socketPath))

    // A leftover socket from a dead daemon would block bind().
    if (existsSync(this.socketPath)) {
      try {
        rmSync(this.socketPath, { force: true })
      } catch {
        // bind() will surface a real problem.
      }
    }

    const server = createServer((socket) => this.onConnection(socket))
    this.server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        try {
          chmodSync(this.socketPath, 0o600)
        } catch {
          // Best effort.
        }
        resolve()
      })
    })
  }

  private onConnection(socket: Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''

    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line !== '') void this.dispatch(socket, line)
        newline = buffer.indexOf('\n')
      }
    })

    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.dropSubscriptions(socket))
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      this.write(socket, {
        id: 'unknown',
        ok: false,
        error: { code: 'usage', message: 'malformed request: expected one JSON object per line' },
      } satisfies Response)
      socket.end()
      return
    }

    const handler = this.handlers[request.method]
    if (!handler) {
      this.write(socket, {
        id: request.id,
        ok: false,
        error: { code: 'usage', message: `unknown method: ${request.method}` },
      } satisfies Response)
      socket.end()
      return
    }

    const keepOpen = request.method === 'subscribe'
    try {
      const data = await handler(request.params ?? {}, {
        socket,
        registerSubscription: (chat) => this.register(socket, chat),
      })
      this.write(socket, { id: request.id, ok: true, data } satisfies Response)
    } catch (error) {
      const payload = toErrorPayload(error)
      this.write(socket, { id: request.id, ok: false, error: payload } satisfies Response)
    } finally {
      if (!keepOpen) socket.end()
    }
  }

  private register(socket: Socket, chat: string | null): string {
    this.subscriptionSeq += 1
    const id = `sub-${this.subscriptionSeq}`
    this.subscriptions.set(id, { socket, chat })
    return id
  }

  private dropSubscriptions(socket: Socket): void {
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.socket === socket) this.subscriptions.delete(id)
    }
  }

  /** Deliver a message event to every subscriber watching that chat. */
  broadcastMessage(record: { chat: string }): void {
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.chat !== null && subscription.chat !== record.chat) continue
      this.write(subscription.socket, {
        event: 'message',
        sub: id,
        data: record,
      } satisfies EventFrame)
    }
  }

  /** Deliver a status event to every subscriber. */
  broadcastStatus(data: unknown): void {
    for (const [id, subscription] of this.subscriptions) {
      this.write(subscription.socket, { event: 'status', sub: id, data } satisfies EventFrame)
    }
  }

  get subscriberCount(): number {
    return this.subscriptions.size
  }

  private write(socket: Socket, frame: unknown): void {
    if (socket.destroyed || socket.writableEnded) return
    try {
      socket.write(`${JSON.stringify(frame)}\n`)
    } catch {
      // Peer went away mid-write.
    }
  }

  async stop(): Promise<void> {
    for (const subscription of this.subscriptions.values()) {
      subscription.socket.destroy()
    }
    this.subscriptions.clear()

    const server = this.server
    this.server = null
    if (!server) return

    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      rmSync(this.socketPath, { force: true })
    } catch {
      // Best effort.
    }
  }
}
