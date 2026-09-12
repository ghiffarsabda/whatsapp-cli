import { appendFileSync, createReadStream, existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { ensureParentDir, ensurePrivateDir, writeFileAtomic } from '../shared/atomic.js'
import type { ChatSummary, ContactSummary, MessageRecord } from '../shared/protocol.js'
import { isGroupJid, numberFromJid, type ChatCandidate } from '../shared/jid.js'
import { displayNameFor } from './ingest.js'

export interface ReadQuery {
  chat?: string
  limit?: number
  since?: number
  before?: number
  from?: string
}

export interface ChatQuery {
  limit?: number
  search?: string
  unreadOnly?: boolean
}

export interface ContactDetails extends ContactSummary {}

interface ChatSnapshot {
  version: number
  updatedAt: string
  unread: Record<string, number>
  names: Record<string, string>
  chats?: ChatSummary[]
  contacts?: ContactDetails[]
}

const SNAPSHOT_DELAY_MS = 250
const DEDUPE_WINDOW = 5000

/**
 * Append-only JSONL is the source of truth; the in-memory chat index is derived
 * from it at startup. Nothing here writes to stdout.
 */
export class Store {
  private readonly chats = new Map<string, ChatSummary>()
  private readonly contacts = new Map<string, ContactDetails>()
  private readonly contactNames = new Map<string, string>()
  private readonly recentIds = new Set<string>()
  private recentIdOrder: string[] = []
  private snapshotTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly messagesFile: string,
    private readonly snapshotFile: string,
  ) {}

  /** Load persisted names/unread, then derive chat summaries from the message log. */
  async load(): Promise<void> {
    const snapshot = this.readSnapshot()
    for (const [jid, name] of Object.entries(snapshot?.names ?? {})) {
      this.contactNames.set(jid, name)
    }
    for (const c of snapshot?.contacts ?? []) {
      this.contacts.set(c.jid, c)
    }
    for (const c of snapshot?.chats ?? []) {
      this.chats.set(c.jid, { ...c })
    }
    const unread = snapshot?.unread ?? {}

    if (!existsSync(this.messagesFile)) return

    await this.stream((record) => {
      const existing = this.chats.get(record.chat)
      if (!existing) {
        this.chats.set(record.chat, {
          jid: record.chat,
          // Contact records win, but the log carries a name too.
          name: this.contactNames.get(record.chat) ?? record.chatName ?? null,
          isGroup: isGroupJid(record.chat),
          lastTs: record.ts,
          lastText: record.text,
          unread: unread[record.chat] ?? 0,
        })
        return
      }
      if (record.ts >= existing.lastTs) {
        existing.lastTs = record.ts
        existing.lastText = record.text
      }
      if (!existing.name && record.chatName) existing.name = record.chatName
    })

    for (const [jid, count] of Object.entries(unread)) {
      const chat = this.chats.get(jid)
      if (chat) chat.unread = count
    }
  }

  private readSnapshot(): ChatSnapshot | null {
    if (!existsSync(this.snapshotFile)) return null
    try {
      return JSON.parse(readFileSync(this.snapshotFile, 'utf8')) as ChatSnapshot
    } catch {
      return null
    }
  }

  private async stream(visit: (record: MessageRecord) => void): Promise<void> {
    if (!existsSync(this.messagesFile)) return
    const input = createReadStream(this.messagesFile, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    for await (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record: MessageRecord
      try {
        record = JSON.parse(trimmed) as MessageRecord
      } catch {
        // A crash can leave a truncated final line; skip it rather than fail.
        continue
      }
      if (typeof record?.chat === 'string' && typeof record?.id === 'string') visit(record)
    }
  }

  /** Append one message and update the derived index. Safe to call repeatedly. */
  append(record: MessageRecord): boolean {
    const dedupeKey = `${record.chat}\u0000${record.id}`
    if (this.recentIds.has(dedupeKey)) return false
    this.rememberId(dedupeKey)

    ensureParentDir(this.messagesFile)
    appendFileSync(this.messagesFile, `${JSON.stringify(record)}\n`, { mode: 0o600 })

    const chat = this.chats.get(record.chat)
    if (chat) {
      if (record.ts >= chat.lastTs) {
        chat.lastTs = record.ts
        chat.lastText = record.text
      }
      if (!record.fromMe) chat.unread += 1
      if (record.chatName) chat.name = record.chatName
    } else {
      this.chats.set(record.chat, {
        jid: record.chat,
        name: record.chatName ?? this.contactNames.get(record.chat) ?? null,
        isGroup: isGroupJid(record.chat),
        lastTs: record.ts,
        lastText: record.text,
        unread: record.fromMe ? 0 : 1,
      })
    }

    this.scheduleSnapshot()
    return true
  }

  private rememberId(key: string): void {
    this.recentIds.add(key)
    this.recentIdOrder.push(key)
    if (this.recentIdOrder.length > DEDUPE_WINDOW) {
      const oldest = this.recentIdOrder.shift()
      if (oldest) this.recentIds.delete(oldest)
    }
  }

  setContact(jid: string, data: { fullName?: string | null; notify?: string | null }): void {
    const existing = this.contacts.get(jid)
    const fullName = data.fullName && data.fullName.trim() !== '' ? data.fullName.trim() : existing?.name ?? null
    const notify = data.notify && data.notify.trim() !== '' ? data.notify.trim() : existing?.notify ?? null
    const isGroup = isGroupJid(jid)
    const phone = isGroup ? null : numberFromJid(jid)

    const updated: ContactDetails = {
      jid,
      name: fullName,
      notify,
      phone,
      isGroup,
    }
    this.contacts.set(jid, updated)

    // Full name always takes priority over push name / notify
    const bestName = fullName ?? notify
    if (bestName) {
      this.contactNames.set(jid, bestName)
      const chat = this.chats.get(jid)
      if (chat) {
        if (fullName || !chat.name) chat.name = bestName
      }
    }
    this.scheduleSnapshot()
  }

  setGroupName(jid: string, subject: string): void {
    const clean = subject.trim()
    if (!clean) return
    this.contactNames.set(jid, clean)
    this.contacts.set(jid, {
      jid,
      name: clean,
      notify: null,
      phone: null,
      isGroup: true,
    })
    const chat = this.chats.get(jid)
    if (chat) {
      chat.name = clean
      chat.isGroup = true
    } else {
      this.chats.set(jid, {
        jid,
        name: clean,
        isGroup: true,
        lastTs: 0,
        lastText: '[group]',
        unread: 0,
      })
    }
    this.scheduleSnapshot()
  }

  touchChat(
    jid: string,
    options: { name?: string | null; unread?: number; lastTs?: number; lastText?: string } = {},
  ): void {
    const existing = this.chats.get(jid)
    const isGroup = isGroupJid(jid)
    const name = options.name ?? this.contactNames.get(jid) ?? existing?.name ?? null
    if (!existing) {
      this.chats.set(jid, {
        jid,
        name,
        isGroup,
        lastTs: options.lastTs ?? 0,
        lastText: options.lastText ?? (isGroup ? '[group]' : ''),
        unread: options.unread ?? 0,
      })
    } else {
      if (options.name && (!existing.name || existing.name === existing.jid)) {
        existing.name = options.name
      }
      if (typeof options.unread === 'number' && options.unread > 0) {
        existing.unread = options.unread
      }
      if (options.lastTs && options.lastTs > existing.lastTs) {
        existing.lastTs = options.lastTs
        if (options.lastText) existing.lastText = options.lastText
      }
    }
    this.scheduleSnapshot()
  }

  setContactName(jid: string, name: string): void {
    if (!name.trim()) return
    this.setContact(jid, { fullName: name })
  }

  contactName(jid: string): string | null {
    return this.contactNames.get(jid) ?? this.chats.get(jid)?.name ?? null
  }

  contact(jid: string): ContactDetails | undefined {
    return this.contacts.get(jid)
  }

  listContacts(query: { search?: string; limit?: number } = {}): ContactDetails[] {
    let list = [...this.contacts.values()]
    if (query.search) {
      const q = query.search.toLowerCase()
      list = list.filter(
        (c) =>
          c.jid.toLowerCase().includes(q) ||
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.notify && c.notify.toLowerCase().includes(q)) ||
          (c.phone && c.phone.includes(q)),
      )
    }
    list.sort((a, b) => (a.name ?? a.notify ?? a.jid).localeCompare(b.name ?? b.notify ?? b.jid))
    return query.limit && query.limit > 0 ? list.slice(0, query.limit) : list
  }

  chat(jid: string): ChatSummary | undefined {
    return this.chats.get(jid)
  }

  listChats(query: ChatQuery = {}): ChatSummary[] {
    let items = [...this.chats.values()]
    if (query.unreadOnly) items = items.filter((chat) => chat.unread > 0)
    if (query.search) {
      const needle = query.search.toLowerCase()
      items = items.filter(
        (chat) =>
          chat.jid.toLowerCase().includes(needle) ||
          (chat.name ?? '').toLowerCase().includes(needle),
      )
    }
    items.sort((a, b) => b.lastTs - a.lastTs)
    return query.limit && query.limit > 0 ? items.slice(0, query.limit) : items
  }

  candidates(): ChatCandidate[] {
    const map = new Map<string, ChatCandidate>()
    for (const chat of this.chats.values()) {
      map.set(chat.jid, {
        jid: chat.jid,
        name: displayNameFor(chat.jid, chat.name),
        isGroup: chat.isGroup,
      })
    }
    for (const contact of this.contacts.values()) {
      if (!map.has(contact.jid)) {
        map.set(contact.jid, {
          jid: contact.jid,
          name: displayNameFor(contact.jid, contact.name ?? contact.notify),
          isGroup: contact.isGroup,
        })
      }
    }
    return [...map.values()]
  }

  /** Read messages from the log, newest last. Scans the whole file. */
  async messages(query: ReadQuery = {}): Promise<MessageRecord[]> {
    const byId = new Map<string, MessageRecord>()
    await this.stream((record) => {
      if (query.chat && record.chat !== query.chat) return
      if (query.from && record.from !== query.from) return
      if (query.since !== undefined && record.ts < query.since) return
      if (query.before !== undefined && record.ts >= query.before) return
      byId.set(`${record.chat}\u0000${record.id}`, record)
    })

    const ordered = [...byId.values()].sort((a, b) => a.ts - b.ts)
    const limit = query.limit ?? 50
    return limit > 0 ? ordered.slice(-limit) : ordered
  }

  async search(text: string, query: ReadQuery = {}): Promise<MessageRecord[]> {
    const needle = text.toLowerCase()
    const matches: MessageRecord[] = []
    const seen = new Set<string>()
    await this.stream((record) => {
      if (query.chat && record.chat !== query.chat) return
      if (query.since !== undefined && record.ts < query.since) return
      if (!record.text.toLowerCase().includes(needle)) return
      const key = `${record.chat}\u0000${record.id}`
      if (seen.has(key)) return
      seen.add(key)
      matches.push(record)
    })
    matches.sort((a, b) => b.ts - a.ts)
    const limit = query.limit ?? 50
    return limit > 0 ? matches.slice(0, limit) : matches
  }

  markRead(jid: string): void {
    const chat = this.chats.get(jid)
    if (!chat) return
    chat.unread = 0
    this.scheduleSnapshot()
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      this.flushSnapshot()
    }, SNAPSHOT_DELAY_MS)
    this.snapshotTimer.unref()
  }

  flushSnapshot(): void {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = null
    }
    const snapshot: ChatSnapshot = {
      version: 2,
      updatedAt: new Date().toISOString(),
      unread: Object.fromEntries(
        [...this.chats.values()].filter((chat) => chat.unread > 0).map((chat) => [chat.jid, chat.unread]),
      ),
      names: Object.fromEntries(this.contactNames),
      chats: [...this.chats.values()],
      contacts: [...this.contacts.values()],
    }
    try {
      ensurePrivateDir(dirname(this.snapshotFile))
      writeFileAtomic(this.snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`)
    } catch {
      // Snapshots are a cache; failure must never break message delivery.
    }
  }
}
