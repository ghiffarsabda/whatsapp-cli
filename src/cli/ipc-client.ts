import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { AppError, daemonUnreachable, timedOut } from '../shared/errors.js'
import { paths } from '../shared/paths.js'
import {
  isEventFrame,
  isResponse,
  type EventFrame,
  type Method,
  type Response,
} from '../shared/protocol.js'

export const DEFAULT_TIMEOUT_MS = 30_000

export interface CallOptions {
  timeoutMs?: number
  socketPath?: string
}

/** `--timeout` is applied process-wide via this env var. */
function defaultTimeout(): number {
  const raw = process.env.WHATSAPP_CLI_TIMEOUT
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

function describeSocketError(error: NodeJS.ErrnoException, socketPath: string): AppError {
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    return daemonUnreachable(
      `No daemon is listening at ${socketPath}`,
      'Run any command to auto-start it, or `wa daemon start`.',
    )
  }
  return daemonUnreachable(`Daemon connection failed (${error.code ?? 'unknown'}): ${error.message}`)
}

function openSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const onError = (error: NodeJS.ErrnoException) => {
      socket.removeAllListeners()
      socket.destroy()
      reject(describeSocketError(error, socketPath))
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.removeListener('error', onError)
      socket.setEncoding('utf8')
      resolve(socket)
    })
  })
}

function writeLine(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`)
}

/** Cheap liveness check: can we open the socket at all? */
export function probe(socketPath = paths().socketPath, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    const done = (result: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

/** One request, one response. Daemon-side failures surface as AppError. */
export async function call<T = unknown>(
  method: Method,
  params: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<T> {
  const socketPath = options.socketPath ?? paths().socketPath
  const timeoutMs = options.timeoutMs ?? defaultTimeout()
  const id = randomUUID()
  const socket = await openSocket(socketPath)

  return new Promise<T>((resolve, reject) => {
    let buffer = ''
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => reject(timedOut(`Request "${method}" timed out after ${timeoutMs}ms`)))
    }, timeoutMs)

    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue

        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (!isResponse(parsed)) continue
        const response = parsed as Response<T>
        if (response.id !== id) continue

        finish(() => {
          if (response.ok) {
            resolve(response.data)
          } else {
            reject(
              new AppError(response.error.code, response.error.message, {
                hint: response.error.hint,
                details: response.error.details,
              }),
            )
          }
        })
        return
      }
    })

    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(describeSocketError(error, socketPath)))
    })
    socket.on('close', () => {
      finish(() =>
        reject(daemonUnreachable(`Daemon closed the connection while handling "${method}"`)),
      )
    })

    writeLine(socket, { id, method, params })
  })
}

export interface Subscription {
  close: () => void
}

/**
 * Stream events from the daemon. The socket stays open until closed, which is
 * what keeps `watch` and `wait` alive.
 */
export async function subscribe(
  chat: string | null,
  onEvent: (frame: EventFrame) => void,
  options: CallOptions = {},
): Promise<Subscription> {
  const socketPath = options.socketPath ?? paths().socketPath
  const id = randomUUID()
  const socket = await openSocket(socketPath)
  let buffer = ''

  socket.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (line === '') continue

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (isEventFrame(parsed)) onEvent(parsed)
    }
  })

  socket.on('error', (error: NodeJS.ErrnoException) => {
    process.stderr.write(`stream error: ${describeSocketError(error, socketPath).message}\n`)
  })

  writeLine(socket, { id, method: 'subscribe', params: { chat } })

  return { close: () => socket.destroy() }
}
