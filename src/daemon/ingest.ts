import type { MessageRecord } from '../shared/protocol.js'
import { isGroupJid, numberFromJid } from '../shared/jid.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Content = Record<string, any>

export interface IncomingMessage {
  key?: {
    id?: string | null
    remoteJid?: string | null
    fromMe?: boolean | null
    participant?: string | null
  } | null
  message?: Content | null
  messageTimestamp?: number | bigint | { toNumber(): number } | null
  pushName?: string | null
}

/** Wrapper messages that only carry another message inside them. */
const ENVELOPES = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
] as const

const PLACEHOLDERS: Record<string, string> = {
  imageMessage: '[image]',
  videoMessage: '[video]',
  audioMessage: '[audio]',
  documentMessage: '[document]',
  stickerMessage: '[sticker]',
  contactMessage: '[contact]',
  contactsArrayMessage: '[contacts]',
  locationMessage: '[location]',
  liveLocationMessage: '[live location]',
  pollCreationMessage: '[poll]',
  pollCreationMessageV2: '[poll]',
  pollCreationMessageV3: '[poll]',
  eventMessage: '[event]',
  reactionMessage: '[reaction]',
  protocolMessage: '[system]',
}

/** Drill through envelopes so we read the real payload. */
export function unwrapContent(content: Content | null | undefined): Content | null {
  let current: Content | null = content ?? null
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const envelope = ENVELOPES.find((key) => current?.[key]?.message)
    if (!envelope) break
    current = current[envelope].message as Content
  }
  return current
}

/** Content type name after unwrapping, e.g. `conversation`, `imageMessage`. */
export function contentTypeOf(content: Content | null | undefined): string {
  const unwrapped = unwrapContent(content)
  if (!unwrapped) return 'unknown'
  const key = Object.keys(unwrapped).find(
    (candidate) => candidate.endsWith('Message') || candidate === 'conversation',
  )
  return key ?? 'unknown'
}

/** Human-readable text for any message, or null when it has none. */
export function textFromContent(content: Content | null | undefined): string | null {
  const unwrapped = unwrapContent(content)
  if (!unwrapped) return null

  const candidates: unknown[] = [
    unwrapped.conversation,
    unwrapped.extendedTextMessage?.text,
    unwrapped.imageMessage?.caption,
    unwrapped.videoMessage?.caption,
    unwrapped.documentMessage?.caption,
    unwrapped.buttonsResponseMessage?.selectedDisplayText,
    unwrapped.templateButtonReplyMessage?.selectedDisplayText,
    unwrapped.listResponseMessage?.title,
    unwrapped.listResponseMessage?.singleSelectReply?.selectedRowId,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

export function placeholderFor(content: Content | null | undefined): string {
  const type = contentTypeOf(content)
  return PLACEHOLDERS[type] ?? `[${type}]`
}

export function toEpochSeconds(value: IncomingMessage['messageTimestamp']): number {
  if (value === null || value === undefined) return Math.floor(Date.now() / 1000)
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value.toNumber === 'function') return value.toNumber()
  return Math.floor(Date.now() / 1000)
}

/** A message is worth storing only if it has a chat and an id. */
export function isStorable(msg: IncomingMessage): boolean {
  return Boolean(msg.key?.remoteJid && msg.key?.id)
}

function contextInfoOf(content: Content | null | undefined): Content | null {
  const unwrapped = unwrapContent(content)
  if (!unwrapped) return null
  return (
    unwrapped.extendedTextMessage?.contextInfo ??
    unwrapped.imageMessage?.contextInfo ??
    unwrapped.videoMessage?.contextInfo ??
    unwrapped.documentMessage?.contextInfo ??
    null
  )
}

export interface RecordOptions {
  chatName?: string | null
  meJid?: string | null
  meName?: string | null
}

export function recordFromMessage(
  msg: IncomingMessage,
  options: RecordOptions = {},
): MessageRecord | null {
  if (!isStorable(msg)) return null

  const chat = msg.key!.remoteJid as string
  const fromMe = Boolean(msg.key!.fromMe)
  const participant = msg.key!.participant ?? null
  const from = fromMe ? options.meJid ?? chat : isGroupJid(chat) ? participant ?? chat : chat

  const contextInfo = contextInfoOf(msg.message)
  const text = textFromContent(msg.message)

  return {
    id: msg.key!.id as string,
    chat,
    chatName: options.chatName ?? null,
    from,
    fromName: fromMe ? options.meName ?? null : msg.pushName ?? null,
    fromMe,
    ts: toEpochSeconds(msg.messageTimestamp),
    type: text === null ? contentTypeOf(msg.message) : 'text',
    text: text ?? placeholderFor(msg.message),
    replyTo: typeof contextInfo?.stanzaId === 'string' ? contextInfo.stanzaId : null,
  }
}

/** Label used for a chat list when no contact or group name is known. */
export function displayNameFor(jid: string, name: string | null | undefined): string | null {
  if (name && name.trim() !== '') return name
  const number = numberFromJid(jid)
  return number === null ? null : `+${number}`
}
