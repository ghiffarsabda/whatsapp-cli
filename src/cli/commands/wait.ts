import { timedOut } from '../../shared/errors.js'
import type { MessageRecord } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { subscribe } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import { renderMessageLine } from '../render.js'
import type { CommandContext } from './context.js'

export interface WaitFlags {
  /** Milliseconds before giving up. Defaults to 30s; 0 waits forever. */
  timeout?: number
  includeFromMe?: boolean
}

const DEFAULT_WAIT_MS = 30_000

/**
 * Block until the next inbound message in a chat, print it, exit.
 * This is the primitive that makes send -> wait -> reply agent loops trivial.
 */
export async function waitCommand(
  chat: string,
  flags: WaitFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  const timeoutMs = flags.timeout ?? DEFAULT_WAIT_MS

  const record = await new Promise<MessageRecord>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let close: (() => void) | undefined

    const finish = (error: unknown, value?: MessageRecord) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      close?.()
      if (error) reject(error)
      else resolve(value as MessageRecord)
    }

    subscribe(chat, (frame) => {
      if (frame.event !== 'message') return
      const incoming = frame.data as MessageRecord
      if (!flags.includeFromMe && incoming.fromMe) return
      finish(null, incoming)
    })
      .then((subscription) => {
        close = subscription.close
        if (settled) close()
      })
      .catch((error: unknown) => finish(error))

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(timedOut(`No message in "${chat}" within ${timeoutMs}ms`))
      }, timeoutMs)
    }

    process.once('SIGINT', () => finish(timedOut('Interrupted')))
  })

  emitOk(record, options, (message) => renderMessageLine(message, options))
}
