import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import type { CommandContext } from './context.js'

export async function syncCommand(
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  const result = await call<{ ok: boolean; chatCount: number; contactCount: number }>('sync', {})

  emitOk(
    result,
    options,
    (res) => `Synced with device: ${res.chatCount} chats, ${res.contactCount} contacts.`,
  )
}
