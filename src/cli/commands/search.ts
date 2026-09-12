import type { MessageRecord } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import { renderMessages } from '../render.js'
import type { CommandContext } from './context.js'

export interface SearchFlags {
  chat?: string
  limit?: number
  since?: number
}

export async function searchCommand(
  query: string,
  flags: SearchFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  const data = await call<{ query: string; messages: MessageRecord[] }>('search', {
    query,
    chat: flags.chat,
    limit: flags.limit,
    since: flags.since,
  })

  emitOk(data, options, (result) =>
    result.messages.length === 0
      ? `No matches for "${result.query}".`
      : renderMessages(result.messages, options),
  )
}
