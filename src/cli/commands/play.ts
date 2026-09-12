import { notFound, usage } from '../../shared/errors.js'
import { playAudio } from '../../shared/media-player.js'
import type { MessageRecord } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import type { CommandContext } from './context.js'

export async function playCommand(
  chat: string,
  messageId: string | undefined,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  const result = await call<{ chat: { jid: string; name: string | null }; messages: MessageRecord[] }>(
    'read',
    { chat, limit: 100 },
  )

  let target: MessageRecord | undefined
  if (messageId) {
    target = result.messages.find((m) => m.id === messageId)
    if (!target) {
      throw notFound(`Message ${messageId} not found in chat ${chat}`)
    }
  } else {
    // Find the newest audio / voice note message
    target = [...result.messages].reverse().find((m) => m.type === 'audioMessage' || m.mediaPath?.match(/\.(ogg|opus|mp3|m4a|wav)$/i))
    if (!target) {
      throw notFound(`No voice note or audio message found in chat ${chat}`)
    }
  }

  if (!target.mediaPath) {
    throw usage(`Message ${target.id} does not have a downloaded audio file.`)
  }

  await playAudio(target.mediaPath)
  emitOk({ playing: true, chat: result.chat.jid, messageId: target.id, file: target.mediaPath }, options, () =>
    `Playing voice note from ${result.chat.name ?? result.chat.jid} (${target.mediaPath})`,
  )
}
