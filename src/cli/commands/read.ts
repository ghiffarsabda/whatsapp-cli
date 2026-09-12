import type { MessageRecord } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import { renderMessages } from '../render.js'
import type { CommandContext } from './context.js'

export interface ReadFlags {
  limit?: number
  since?: number
  before?: number
}

export interface ReadResult {
  chat: { jid: string; name: string | null }
  messages: MessageRecord[]
}

export async function readCommand(
  chat: string,
  flags: ReadFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  const data = await call<ReadResult>('read', {
    chat,
    limit: flags.limit,
    since: flags.since,
    before: flags.before,
  })

  emitOk(data, options, (result) => {
    const header = result.chat.name ? `${result.chat.name} <${result.chat.jid}>` : result.chat.jid
    const body = renderMessages(result.messages, options)
    return `${header}\n\n${body}`
  })
}
