import type { ErrorPayload } from './errors.js'

export const PROTOCOL_VERSION = 1

export type ConnectionStatus = 'connecting' | 'open' | 'close' | 'logged_out'

export interface MessageRecord {
  id: string
  chat: string
  chatName: string | null
  from: string
  fromName: string | null
  fromMe: boolean
  ts: number
  type: string
  text: string
  replyTo?: string | null
  mediaPath?: string | null
  mimetype?: string | null
  fileName?: string | null
  duration?: number | null
}

export interface ChatSummary {
  jid: string
  name: string | null
  isGroup: boolean
  lastTs: number
  lastText: string
  unread: number
}

export interface ContactSummary {
  jid: string
  name: string | null
  notify: string | null
  phone: string | null
  isGroup: boolean
}

export interface MeInfo {
  jid: string
  name: string | null
  number: string | null
}

export interface DaemonState {
  version: number
  pid: number
  startedAt: string
  connection: ConnectionStatus
  loggedIn: boolean
  me: MeInfo | null
  qr: { value: string; issuedAt: string } | null
  pairingCode: { code: string; issuedAt: string } | null
  reconnect: { attempts: number; nextAt: string | null }
  lastDisconnect: { statusCode: number | null; message: string; at: string } | null
}

export interface SendResult {
  messageId: string
  chat: string
  timestamp: number
}

export interface LoginResult {
  connection: ConnectionStatus
  loggedIn: boolean
  me: MeInfo | null
  qr: string | null
  pairingCode: string | null
}

export type Method =
  | 'status'
  | 'chats'
  | 'contacts'
  | 'read'
  | 'search'
  | 'send'
  | 'sendMedia'
  | 'sync'
  | 'subscribe'
  | 'ensureLogin'
  | 'logout'
  | 'shutdown'

export interface Request {
  id: string
  method: Method
  params?: Record<string, unknown>
}

export interface OkResponse<T = unknown> {
  id: string
  ok: true
  data: T
}

export interface ErrResponse {
  id: string
  ok: false
  error: ErrorPayload
}

export type Response<T = unknown> = OkResponse<T> | ErrResponse

export interface EventFrame {
  event: 'message' | 'status'
  sub: string
  data: unknown
}

export function isEventFrame(value: unknown): value is EventFrame {
  return typeof value === 'object' && value !== null && 'event' in value && 'sub' in value
}

export function isResponse(value: unknown): value is Response {
  return typeof value === 'object' && value !== null && 'id' in value && 'ok' in value
}
