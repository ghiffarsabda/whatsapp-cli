import { readFileSync } from 'node:fs'
import { usage } from '../../shared/errors.js'
import type { SendResult } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'
import { renderSendResult } from '../render.js'
import type { CommandContext } from './context.js'

export interface SendFlags {
  bodyFile?: string
  document?: string
  image?: string
  voice?: string
  audio?: string
  caption?: string
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Body comes from the argument, from `-` (stdin), or from `--body-file`, so
 * agents never have to fight shell escaping for long or multi-line text.
 */
async function resolveBody(text: string | undefined, flags: SendFlags): Promise<string> {
  if (flags.bodyFile) {
    try {
      return readFileSync(flags.bodyFile, 'utf8')
    } catch (error) {
      throw usage(`Cannot read --body-file ${flags.bodyFile}: ${(error as Error).message}`)
    }
  }
  if (text === '-') return readStdin()
  return text ?? ''
}

export async function sendCommand(
  chat: string,
  text: string | undefined,
  flags: SendFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  if (flags.document) {
    const caption = flags.caption ?? (text && text !== '-' ? text : undefined)
    const result = await call<SendResult>('sendMedia', {
      chat,
      path: flags.document,
      type: 'document',
      caption,
    })
    emitOk(result, options, renderSendResult)
    return
  }

  if (flags.image) {
    const caption = flags.caption ?? (text && text !== '-' ? text : undefined)
    const result = await call<SendResult>('sendMedia', {
      chat,
      path: flags.image,
      type: 'image',
      caption,
    })
    emitOk(result, options, renderSendResult)
    return
  }

  if (flags.voice) {
    const result = await call<SendResult>('sendMedia', {
      chat,
      path: flags.voice,
      type: 'voice',
    })
    emitOk(result, options, renderSendResult)
    return
  }

  if (flags.audio) {
    const result = await call<SendResult>('sendMedia', {
      chat,
      path: flags.audio,
      type: 'audio',
    })
    emitOk(result, options, renderSendResult)
    return
  }

  const body = (await resolveBody(text, flags)).replace(/\s+$/, '')
  if (body.trim() === '') throw usage('Refusing to send an empty message')

  const result = await call<SendResult>('send', { chat, text: body })
  emitOk(result, options, renderSendResult)
}
