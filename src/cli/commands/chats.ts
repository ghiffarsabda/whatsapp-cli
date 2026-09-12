import type { ChatSummary } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import { renderChats } from '../render.js'
import type { CommandContext } from './context.js'

export interface ChatsFlags {
  limit?: number
  search?: string
  unread?: boolean
}

export async function chatsCommand(
  flags: ChatsFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  const data = await call<{ chats: ChatSummary[] }>('chats', {
    limit: flags.limit,
    search: flags.search,
    unread: flags.unread === true,
  })

  emitOk(data, options, (result) => renderChats(result.chats, options))
}
