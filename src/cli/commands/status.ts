import type { DaemonState } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import { renderState } from '../render.js'
import type { CommandContext } from './context.js'

export type StatusResult = DaemonState & { chatCount: number; subscribers: number }

export async function statusCommand(
  options: OutputOptions,
  context: CommandContext,
): Promise<StatusResult> {
  await ensureDaemon({ dataDir: context.dataDir })
  const state = await call<StatusResult>('status')
  emitOk(state, options, renderState)
  return state
}
