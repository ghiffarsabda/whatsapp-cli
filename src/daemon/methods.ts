import { ambiguity, notFound, usage } from '../shared/errors.js'
import { resolveChatRef } from '../shared/jid.js'
import type { LoginResult } from '../shared/protocol.js'
import type { ConnectionContext, MethodHandler } from './ipc-server.js'
import type { WaConnection } from './baileys.js'
import type { Store } from './store.js'

export interface MethodDeps {
  store: Store
  connection: WaConnection
  requestShutdown: () => void
  subscriberCount: () => number
}

function defaultCountry(): string | undefined {
  const value = process.env.WHATSAPP_CLI_COUNTRY
  return value && value.trim() !== '' ? value.trim().toUpperCase() : undefined
}

function resolveExistingChat(store: Store, ref: string): string {
  const candidates = store.candidates()
  const result = resolveChatRef(ref, candidates, defaultCountry())

  if (result.ok && store.chat(result.jid)) return result.jid
  if (result.ok) {
    throw notFound(`No chat matching "${ref}"`, 'Run `wa chats` to list known chats.')
  }
  if (result.reason === 'ambiguous') {
    throw ambiguity(`"${ref}" matches ${result.candidates.length} chats`, {
      candidates: result.candidates.map((candidate) => candidate.jid),
    })
  }
  throw notFound(`No chat matching "${ref}"`, 'Run `wa chats` to list known chats.')
}

/** Sending tolerates unknown numbers: the JID is synthesized from the phone number. */
function resolveSendTarget(store: Store, ref: string): string {
  const trimmed = ref.trim()
  if (trimmed.includes('@')) {
    const exact = store.candidates().find((c) => c.jid.toLowerCase() === trimmed.toLowerCase())
    return exact ? exact.jid : trimmed
  }

  const result = resolveChatRef(trimmed, store.candidates(), defaultCountry())
  if (result.ok) return result.jid
  if (result.reason === 'ambiguous') {
    throw ambiguity(`"${ref}" matches ${result.candidates.length} chats`, {
      candidates: result.candidates.map((candidate) => candidate.jid),
    })
  }
  throw notFound(
    `No chat or phone number matching "${ref}"`,
    'Pass a phone number in international format, e.g. +628123456789.',
  )
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw usage(`Missing required string parameter: ${key}`)
  }
  return value
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function buildHandlers(deps: MethodDeps): Record<string, MethodHandler> {
  const { store, connection } = deps

  return {
    status: async () => {
      const state = connection.getState()
      return {
        ...state,
        chatCount: store.listChats().length,
        subscribers: deps.subscriberCount(),
      }
    },

    chats: async (params) => {
      const chats = store.listChats({
        limit: optionalNumber(params, 'limit'),
        search: typeof params.search === 'string' ? params.search : undefined,
        unreadOnly: params.unread === true,
      })
      return { chats }
    },

    read: async (params) => {
      const ref = requireString(params, 'chat')
      const jid = resolveExistingChat(store, ref)
      const messages = await store.messages({
        chat: jid,
        limit: optionalNumber(params, 'limit') ?? 50,
        since: optionalNumber(params, 'since'),
        before: optionalNumber(params, 'before'),
      })
      store.markRead(jid)
      return {
        chat: { jid, name: store.contactName(jid) },
        messages,
      }
    },

    search: async (params) => {
      const query = requireString(params, 'query')
      const chatRef = typeof params.chat === 'string' ? params.chat : undefined
      const jid = chatRef ? resolveExistingChat(store, chatRef) : undefined
      const messages = await store.search(query, {
        chat: jid,
        limit: optionalNumber(params, 'limit') ?? 50,
        since: optionalNumber(params, 'since'),
      })
      return { query, messages }
    },

    send: async (params) => {
      const ref = requireString(params, 'chat')
      const text = requireString(params, 'text')
      const jid = resolveSendTarget(store, ref)
      return connection.sendText(jid, text)
    },

    subscribe: async (params, context: ConnectionContext) => {
      const chatRef = typeof params.chat === 'string' && params.chat.trim() !== '' ? params.chat : null
      const jid = chatRef ? resolveExistingChat(store, chatRef) : null
      const sub = context.registerSubscription(jid)
      return { sub, chat: jid, connection: connection.getState().connection }
    },

    ensureLogin: async (params) => {
      const phone = typeof params.phone === 'string' ? params.phone : null
      let pairingCode: string | null = null

      if (phone && !connection.isRegistered()) {
        const digits = phone.replace(/[^\d]/g, '')
        if (digits.length < 6) throw usage('Phone number must include a country code, digits only.')
        pairingCode = await connection.requestPairingCode(digits)
      }

      const state = connection.getState()
      const result: LoginResult = {
        connection: state.connection,
        loggedIn: state.loggedIn,
        me: state.me,
        qr: state.qr?.value ?? null,
        pairingCode,
      }
      return result
    },

    logout: async () => {
      await connection.logout()
      return { loggedIn: false }
    },

    shutdown: async () => {
      deps.requestShutdown()
      return { stopping: true }
    },
  }
}
