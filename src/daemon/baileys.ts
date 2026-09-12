import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys'
import type { Logger } from 'pino'
import { ensurePrivateDir } from '../shared/atomic.js'
import { notFound, notLoggedIn, timedOut } from '../shared/errors.js'
import type { DaemonState, MessageRecord, SendResult } from '../shared/protocol.js'
import { isGroupJid, numberFromJid } from '../shared/jid.js'
import { defaultState } from '../shared/state-file.js'
import { recordFromMessage, unwrapContent, type IncomingMessage } from './ingest.js'
import type { Store } from './store.js'

const MAX_BACKOFF_MS = 30_000
const BASE_BACKOFF_MS = 1_000
const OPEN_TIMEOUT_MS = 15_000

type ContactLike = {
  id?: string | null
  name?: string | null
  notify?: string | null
  verifiedName?: string | null
}
type ChatLike = { id?: string | null; name?: string | null; unreadCount?: number | null }

export interface WaConnectionOptions {
  authDir: string
  mediaDir?: string
  store: Store
  logger: Logger
  onStateChange: (state: DaemonState) => void
  onMessage: (record: MessageRecord) => void
}

/**
 * Owns the persistent WhatsApp socket.
 *
 * Credentials live on disk, so a restart reconnects without pairing again. The
 * only paths that discard them are an explicit logout, or WhatsApp telling us
 * the device was unlinked.
 */
export class WaConnection {
  private sock: WASocket | null = null
  private state: DaemonState = defaultState(process.pid)
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private stopped = false
  private loggedOut = false

  constructor(private readonly options: WaConnectionOptions) {}

  getState(): DaemonState {
    return this.state
  }

  isOpen(): boolean {
    return this.state.connection === 'open' && this.sock !== null
  }

  isRegistered(): boolean {
    return Boolean(this.sock?.authState?.creds?.registered)
  }

  private mutate(patch: Partial<DaemonState>): void {
    this.state = { ...this.state, ...patch }
    this.options.onStateChange(this.state)
  }

  async start(): Promise<void> {
    ensurePrivateDir(this.options.authDir)
    this.stopped = false
    await this.connect()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return

    // Restores the saved session, so no QR is shown when creds are on disk.
    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir)
    const registered = Boolean(state.creds?.registered)

    let version: [number, number, number] | undefined
    try {
      version = (await fetchLatestBaileysVersion()).version as [number, number, number]
    } catch {
      version = undefined // Offline: fall back to the version bundled with Baileys.
    }

    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: this.options.logger,
      browser: Browsers.ubuntu('whatsapp-cli'),
      // Leave the phone receiving push notifications while we are connected.
      markOnlineOnConnect: false,
      // Backfill history on first link so `read` has something to show.
      syncFullHistory: true,
      generateHighQualityLinkPreview: false,
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (update) => {
      void this.onConnectionUpdate(update)
    })
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      // `notify` is live traffic; `append` and history replay must stay quiet.
      this.ingest(messages as unknown as IncomingMessage[], type !== 'notify')
    })
    sock.ev.on('messaging-history.set', ({ messages, contacts, chats }) => {
      this.ingestContacts(contacts as ContactLike[])
      this.ingestChats(chats as ChatLike[])
      this.ingest(messages as unknown as IncomingMessage[], true)
    })
    sock.ev.on('contacts.upsert', (contacts) => this.ingestContacts(contacts as ContactLike[]))
    sock.ev.on('contacts.update', (contacts) => this.ingestContacts(contacts as ContactLike[]))
    sock.ev.on('chats.upsert', (chats) => this.ingestChats(chats as ChatLike[]))
    sock.ev.on('chats.update', (chats) => this.ingestChats(chats as ChatLike[]))
    sock.ev.on('groups.upsert', (groups) => this.ingestGroups(groups))
    sock.ev.on('groups.update', (groups) => this.ingestGroups(groups))

    this.mutate({
      connection: 'connecting',
      loggedIn: registered,
      ...(version ? { baileysVersion: version } : {}),
    })
  }

  private async onConnectionUpdate(update: {
    connection?: string
    lastDisconnect?: { error?: unknown }
    qr?: string
  }): Promise<void> {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      this.mutate({
        connection: 'connecting',
        qr: { value: qr, issuedAt: new Date().toISOString() },
        pairingCode: null,
      })
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0
      const user = this.sock?.user
      const jid = user?.id ? jidNormalizedUser(user.id) : null
      this.mutate({
        connection: 'open',
        loggedIn: true,
        me: jid
          ? { jid, name: user?.name ?? user?.verifiedName ?? null, number: numberFromJid(jid) }
          : null,
        qr: null,
        pairingCode: null,
        reconnect: { attempts: 0, nextAt: null },
      })
      this.options.logger.info({ jid }, 'connection open')
      void this.syncGroups()
      return
    }

    if (connection === 'close') {
      const statusCode = extractStatusCode(lastDisconnect?.error)
      const message =
        lastDisconnect?.error instanceof Error ? lastDisconnect.error.message : 'disconnected'

      if (statusCode === DisconnectReason.loggedOut) {
        this.loggedOut = true
        this.clearAuth()
        this.mutate({
          connection: 'logged_out',
          loggedIn: false,
          me: null,
          qr: null,
          pairingCode: null,
          lastDisconnect: { statusCode: statusCode ?? null, message, at: new Date().toISOString() },
        })
        this.options.logger.warn('logged out by WhatsApp; credentials cleared')
        return
      }

      this.scheduleReconnect(statusCode ?? null, message)
    }
  }

  private scheduleReconnect(statusCode: number | null, message: string): void {
    if (this.stopped) return
    this.reconnectAttempts += 1
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (this.reconnectAttempts - 1), MAX_BACKOFF_MS)

    this.mutate({
      connection: 'close',
      lastDisconnect: { statusCode, message, at: new Date().toISOString() },
      reconnect: {
        attempts: this.reconnectAttempts,
        nextAt: new Date(Date.now() + delay).toISOString(),
      },
    })
    this.options.logger.warn({ statusCode, delay, attempt: this.reconnectAttempts }, 'reconnecting')

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch((error: unknown) => {
        this.options.logger.error({ error }, 'reconnect failed')
        this.scheduleReconnect(null, error instanceof Error ? error.message : String(error))
      })
    }, delay)
  }

  async syncGroups(): Promise<void> {
    const sock = this.sock
    if (!sock) return
    try {
      const groups = await sock.groupFetchAllParticipating()
      for (const [id, metadata] of Object.entries(groups)) {
        if (metadata?.subject) {
          this.options.store.setGroupName(id, metadata.subject)
        }
      }
      this.options.logger.info({ groupCount: Object.keys(groups).length }, 'synced participating groups')
    } catch (error) {
      this.options.logger.warn({ error }, 'group sync error')
    }
  }

  private ingestGroups(groups: Array<{ id?: string | null; subject?: string | null }>): void {
    for (const group of groups ?? []) {
      if (group?.id && group?.subject) {
        this.options.store.setGroupName(group.id, group.subject)
      }
    }
  }

  private ingest(messages: IncomingMessage[], historical: boolean): void {
    const meJid = this.state.me?.jid ?? null
    const meName = this.state.me?.name ?? null

    for (const message of messages) {
      const chat = message.key?.remoteJid ?? null
      if (!chat) continue

      const isGroup = isGroupJid(chat)

      // Learn contact names before reply!
      if (!isGroup && message.pushName) {
        const userJid = jidNormalizedUser(chat)
        if (!this.options.store.contactName(userJid)) {
          this.options.store.setContact(userJid, { notify: message.pushName })
        }
      }
      const participant = message.key?.participant
      if (isGroup && participant && message.pushName) {
        const partJid = jidNormalizedUser(participant)
        if (!this.options.store.contactName(partJid)) {
          this.options.store.setContact(partJid, { notify: message.pushName })
        }
      }

      const record = recordFromMessage(message, {
        chatName: this.options.store.contactName(chat),
        meJid,
        meName,
      })
      if (!record) continue

      if (this.options.mediaDir && message.key?.id) {
        void this.downloadMedia(message, chat, message.key.id).then((mediaPath) => {
          if (mediaPath) {
            record.mediaPath = mediaPath
          }
        })
      }

      const stored = this.options.store.append(record)
      if (stored && !historical) this.options.onMessage(record)
    }
  }

  private ingestContacts(contacts: ContactLike[]): void {
    for (const contact of contacts ?? []) {
      if (!contact?.id) continue
      const jid = jidNormalizedUser(contact.id)
      const fullName = contact.name ?? contact.verifiedName ?? null
      const notify = contact.notify ?? null
      this.options.store.setContact(jid, { fullName, notify })
    }
  }

  private ingestChats(chats: ChatLike[]): void {
    for (const chat of chats ?? []) {
      if (!chat?.id) continue
      const jid = chat.id.includes('@') ? chat.id : `${chat.id}@s.whatsapp.net`
      const normalized = isGroupJid(jid) ? jid : jidNormalizedUser(jid)
      if (chat.name) {
        if (isGroupJid(normalized)) {
          this.options.store.setGroupName(normalized, chat.name)
        } else {
          this.options.store.setContactName(normalized, chat.name)
        }
      }
      this.options.store.touchChat(normalized, {
        name: chat.name ?? undefined,
        unread: typeof chat.unreadCount === 'number' ? chat.unreadCount : undefined,
      })
    }
  }

  private clearAuth(): void {
    try {
      rmSync(this.options.authDir, { recursive: true, force: true })
    } catch (error) {
      this.options.logger.error({ error }, 'failed to clear auth dir')
    }
  }

  /** Resolve once the socket is open, or throw a coded error after `timeoutMs`. */
  async waitForOpen(timeoutMs = OPEN_TIMEOUT_MS): Promise<void> {
    if (this.isOpen()) return

    // Fail fast when there are no credentials at all: there is nothing to wait for.
    const unauthenticated = () =>
      this.loggedOut ||
      this.state.connection === 'logged_out' ||
      (this.sock !== null && this.sock.authState?.creds !== undefined && !this.isRegistered())

    if (unauthenticated()) throw notLoggedIn()

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.isOpen()) return
      if (unauthenticated()) throw notLoggedIn()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw timedOut('Timed out waiting for the WhatsApp connection', 'Check `wa status`.')
  }

  async sendText(jid: string, text: string): Promise<SendResult> {
    await this.waitForOpen()
    const sock = this.sock
    if (!sock) throw notLoggedIn()

    const sent = await sock.sendMessage(jid, { text })
    const messageId = sent?.key?.id
    if (!sent || !messageId) throw new Error('send failed: no message id returned')

    // Reflect the outgoing message in the local log immediately.
    const record = recordFromMessage(sent as unknown as IncomingMessage, {
      chatName: this.options.store.contactName(jid),
      meJid: this.state.me?.jid ?? null,
      meName: this.state.me?.name ?? null,
    })
    if (record) {
      this.options.store.append(record)
      this.options.onMessage(record)
    }

    return {
      messageId,
      chat: jid,
      timestamp:
        typeof sent.messageTimestamp === 'number'
          ? sent.messageTimestamp
          : Math.floor(Date.now() / 1000),
    }
  }

  async sendMedia(
    jid: string,
    filePath: string,
    options: {
      type?: 'image' | 'audio' | 'voice' | 'document'
      caption?: string
      fileName?: string
    } = {},
  ): Promise<SendResult> {
    await this.waitForOpen()
    const sock = this.sock
    if (!sock) throw notLoggedIn()

    if (!existsSync(filePath)) {
      throw notFound(`Media file not found: ${filePath}`)
    }

    const buffer = readFileSync(filePath)
    const fileExt = extname(filePath).toLowerCase()
    const name = options.fileName ?? basename(filePath)

    let inferredType = options.type
    if (!inferredType) {
      if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(fileExt)) {
        inferredType = 'image'
      } else if (['.ogg', '.opus', '.mp3', '.m4a', '.wav', '.aac'].includes(fileExt)) {
        inferredType = 'voice'
      } else {
        inferredType = 'document'
      }
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let payload: any
    if (inferredType === 'image') {
      payload = {
        image: buffer,
        caption: options.caption || undefined,
      }
    } else if (inferredType === 'voice') {
      payload = {
        audio: buffer,
        mimetype: fileExt === '.mp3' ? 'audio/mpeg' : 'audio/ogg; codecs=opus',
        ptt: true,
      }
    } else if (inferredType === 'audio') {
      payload = {
        audio: buffer,
        mimetype: fileExt === '.mp3' ? 'audio/mpeg' : 'audio/ogg; codecs=opus',
        ptt: false,
      }
    } else {
      const mime =
        fileExt === '.pdf'
          ? 'application/pdf'
          : fileExt === '.zip'
            ? 'application/zip'
            : fileExt === '.txt'
              ? 'text/plain'
              : 'application/octet-stream'
      payload = {
        document: buffer,
        mimetype: mime,
        fileName: name,
        caption: options.caption || undefined,
      }
    }

    const sent = await sock.sendMessage(jid, payload)
    const messageId = sent?.key?.id
    if (!sent || !messageId) throw new Error('send failed: no message id returned')

    const record = recordFromMessage(sent as unknown as IncomingMessage, {
      chatName: this.options.store.contactName(jid),
      meJid: this.state.me?.jid ?? null,
      meName: this.state.me?.name ?? null,
      mediaPath: filePath,
    })
    if (record) {
      this.options.store.append(record)
      this.options.onMessage(record)
    }

    return {
      messageId,
      chat: jid,
      timestamp:
        typeof sent.messageTimestamp === 'number'
          ? sent.messageTimestamp
          : Math.floor(Date.now() / 1000),
    }
  }

  async downloadMedia(
    msg: IncomingMessage,
    chat: string,
    messageId: string,
  ): Promise<string | null> {
    if (!this.options.mediaDir) return null
    const unwrapped = unwrapContent(msg.message)
    if (!unwrapped) return null

    let type: 'image' | 'audio' | 'document' | null = null
    let ext = ''
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let mediaObj: any = null

    if (unwrapped.imageMessage) {
      type = 'image'
      ext = '.jpeg'
      mediaObj = unwrapped.imageMessage
    } else if (unwrapped.audioMessage) {
      type = 'audio'
      ext = unwrapped.audioMessage.ptt ? '.ogg' : '.m4a'
      mediaObj = unwrapped.audioMessage
    } else if (unwrapped.documentMessage) {
      type = 'document'
      mediaObj = unwrapped.documentMessage
      const originalExt = mediaObj.fileName ? extname(mediaObj.fileName) : ''
      ext = originalExt || '.bin'
    }

    if (!type || !mediaObj || !mediaObj.mediaKey) return null

    try {
      const safeChat = chat.replace(/[^a-zA-Z0-9_-]/g, '_')
      const chatDir = join(this.options.mediaDir, safeChat)
      ensurePrivateDir(chatDir)
      const filePath = join(chatDir, `${messageId}${ext}`)
      if (existsSync(filePath)) return filePath

      const stream = await downloadContentFromMessage(mediaObj, type)
      const out = createWriteStream(filePath)
      await pipeline(stream, out)
      return filePath
    } catch (error) {
      this.options.logger.warn({ error, messageId }, 'failed to download media')
      return null
    }
  }

  async requestPairingCode(phone: string): Promise<string> {
    const sock = this.sock
    if (!sock) throw notLoggedIn()
    const code = await sock.requestPairingCode(phone)
    this.mutate({
      connection: 'connecting',
      pairingCode: { code, issuedAt: new Date().toISOString() },
      qr: null,
    })
    return code
  }

  async logout(): Promise<void> {
    try {
      await this.sock?.logout()
    } catch {
      // Already invalid server-side; clearing locally is still correct.
    }
    this.loggedOut = true
    this.clearAuth()
    this.mutate({
      connection: 'logged_out',
      loggedIn: false,
      me: null,
      qr: null,
      pairingCode: null,
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.sock?.ev.removeAllListeners('connection.update')
      this.sock?.end(undefined)
    } catch {
      // Shutting down anyway.
    }
    this.sock = null
  }
}

function extractStatusCode(error: unknown): number | undefined {
  const output = (error as { output?: { statusCode?: number } } | undefined)?.output
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined
}
