import type { MessageRecord } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { subscribe } from '../ipc-client.js'
import { emitFrame, type OutputOptions } from '../output.js'
import { renderMessageLine } from '../render.js'
import type { CommandContext } from './context.js'

export interface WatchFlags {
  chat?: string
  once?: boolean
  /** Milliseconds; 0 or undefined means stream forever. */
  timeout?: number
}

/**
 * Stream incoming messages. JSON mode emits NDJSON, one event per line, so it
 * can be piped straight into `jq`.
 */
export async function watchCommand(
  flags: WatchFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let close: (() => void) | undefined

    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      close?.()
      if (error) reject(error)
      else resolve()
    }

    subscribe(flags.chat ?? null, (frame) => {
      if (frame.event !== 'message') return
      const record = frame.data as MessageRecord

      if (options.format === 'json') {
        emitFrame({ event: 'message', data: record })
      } else if (!options.quiet) {
        process.stdout.write(`${renderMessageLine(record, options)}\n`)
      }

      if (flags.once) finish()
    })
      .then((subscription) => {
        close = subscription.close
        if (settled) close()
      })
      .catch(finish)

    if (flags.timeout && flags.timeout > 0) {
      timer = setTimeout(() => finish(), flags.timeout)
    }

    process.once('SIGINT', () => finish())
  })
}
