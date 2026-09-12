import type { ContactSummary } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import { renderContacts } from '../render.js'
import type { CommandContext } from './context.js'

export interface ContactsFlags {
  limit?: number
  search?: string
}

export async function contactsCommand(
  flags: ContactsFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  const data = await call<{ contacts: ContactSummary[] }>('contacts', {
    limit: flags.limit,
    search: flags.search,
  })

  emitOk(data, options, (result) => renderContacts(result.contacts, options))
}
