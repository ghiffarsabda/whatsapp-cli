import { appendFileSync, createReadStream, existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { ensureParentDir, ensurePrivateDir, writeFileAtomic } from '../shared/atomic.js'
import type { ChatSummary, ContactSummary, MessageRecord } from '../shared/protocol.js'
import { isGroupJid, isIgnoredJid, isLidJid, isPnJid, numberFromJid, type ChatCandidate } from '../shared/jid.js'
import { displayNameFor, isNoiseType } from './ingest.js'

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
  /** LID/phone aliases: alternate jid -> canonical jid. */
  aliases?: Record<string, string>
}

const SNAPSHOT_DELAY_MS = 250
const DEDUPE_WINDOW = 5000

/** Prefer the phone-number JID as the single canonical identity for a person. */
function pickCanonical(a: string, b: string): string {
  if (a === b) return a
  if (isPnJid(a) && !isPnJid(b)) return a
  if (isPnJid(b) && !isPnJid(a)) return b
  return a
}

function betterName(a: string | null, b: string | null, jid: string): string | null {
  const local = jid.split('@')[0]
  const candidates = [a, b].filter(
    (name): name is string => typeof name === 'string' && name.trim() !== '',
  )
  const meaningful = candidates.find((name) => name !== jid && name !== local)
  return meaningful ?? candidates[0] ?? null
}

function mergeChatSummaries(a: ChatSummary, b: ChatSummary): ChatSummary {
  const newer = a.lastTs >= b.lastTs ? a : b
  return {
    jid: a.jid,
    name: betterName(a.name, b.name, a.jid),
    isGroup: a.isGroup || b.isGroup,
    lastTs: Math.max(a.lastTs, b.lastTs),
    lastText: newer.lastText,
    unread: Math.max(0, a.unread) + Math.max(0, b.unread),
  }
}

function mergeContactDetails(a: ContactDetails, b: ContactDetails): ContactDetails {
  return {
    jid: a.jid,
    name: a.name ?? b.name,
    notify: a.notify ?? b.notify,
    phone: a.phone ?? b.phone,
    isGroup: a.isGroup || b.isGroup,
  }
}

/**
 * Append-only JSONL is the source of truth; the in-memory chat index is derived
 * from it at startup. Nothing here writes to stdout.
 */
export class Store {
  private readonly chats = new Map<string, ChatSummary>()
  private readonly contacts = new Map<string, ContactDetails>()
  private readonly contactNames = new Map<string, string>()
  /** Alternate identity -> canonical identity (e.g. `<id>@lid` -> `<number>@s.whatsapp.net`). */
  private readonly aliases = new Map<string, string>()
  private readonly recentIds = new Set<string>()
  private recentIdOrder: string[] = []
  private snapshotTimer: NodeJS.Timeout | null = null
  /** Our own jid, hidden from the chat list (self-chat from linked devices). */
  private selfJid: string | null = null

  constructor(
    private readonly messagesFile: string,
    private readonly snapshotFile: string,
  ) {}

  /** Record our own identity so it never shows up as a conversation. */
  setSelfJid(jid: string | null): void {
    this.selfJid = jid ? this.canonicalJid(jid) : null
  }

  /**
   * Fold WhatsApp's two identities for one person (phone-number JID and LID)
   * into a single chat/contact so messages never split across two rooms.
   */
  linkJids(ids: Array<string | null | undefined>): void {
    const resolved = [
      ...new Set(
        ids
          .filter((jid): jid is string => typeof jid === 'string' && jid.trim() !== '')
          .map((jid) => this.canonicalJid(jid)),
      ),
    ]
    if (resolved.length < 2) return

    let canonical = resolved[0]!
    for (const jid of resolved) canonical = pickCanonical(canonical, jid)
    if (resolved.every((jid) => jid === canonical)) return

    for (const jid of resolved) {
      if (jid === canonical) continue
      this.aliases.set(jid, canonical)
      this.mergeJidEntries(canonical, jid)
    }
    this.scheduleSnapshot()
  }

  /** Follow aliases to the single canonical jid for this person. */
  canonicalJid(jid: string): string {
    let current = jid
    for (let i = 0; i < 8; i += 1) {
      const next = this.aliases.get(current)
      if (!next || next === current) break
      current = next
    }
    return current
  }

  /** Every jid that refers to the same person, canonical first. */
  jidVariants(jid: string): string[] {
    const canonical = this.canonicalJid(jid)
    const variants = [canonical]
    for (const [alias, target] of this.aliases) {
      if (target === canonical && alias !== canonical) variants.push(alias)
    }
    if (!variants.includes(jid)) variants.push(jid)
    return variants
  }

  /**
   * Phone-number chats whose LID counterpart is still unknown. Already-linked
   * identities are skipped so a sync stays cheap and idempotent.
   */
  directPhoneJids(): string[] {
    const linked = new Set(this.aliases.values())
    const jids = new Set<string>()
    for (const chat of this.chats.values()) {
      if (chat.isGroup || !isPnJid(chat.jid) || isIgnoredJid(chat.jid)) continue
      if (linked.has(chat.jid)) continue
      jids.add(chat.jid)
    }
    return [...jids]
  }

  private mergeJidEntries(target: string, source: string): void {
    if (target === source) return

    const sourceChat = this.chats.get(source)
    if (sourceChat) {
      const targetChat = this.chats.get(target)
      this.chats.set(target, targetChat ? mergeChatSummaries(targetChat, sourceChat) : { ...sourceChat, jid: target })
      this.chats.delete(source)
    }

    const sourceContact = this.contacts.get(source)
    if (sourceContact) {
      const targetContact = this.contacts.get(target)
      this.contacts.set(
        target,
        targetContact ? mergeContactDetails(targetContact, sourceContact) : { ...sourceContact, jid: target },
      )
      this.contacts.delete(source)
    }

    const sourceName = this.contactNames.get(source)
    if (sourceName && !this.contactNames.get(target)) this.contactNames.set(target, sourceName)
    this.contactNames.delete(source)
  }

  /** Re-merge chats/contacts now that persisted aliases are known. */
  private reindexAliases(): void {
    if (this.aliases.size === 0) return

    const chats = new Map<string, ChatSummary>()
    for (const chat of this.chats.values()) {
      const jid = this.canonicalJid(chat.jid)
      const existing = chats.get(jid)
      chats.set(jid, existing ? mergeChatSummaries(existing, chat) : { ...chat, jid })
    }
    this.chats.clear()
    for (const [jid, chat] of chats) this.chats.set(jid, chat)

    const contacts = new Map<string, ContactDetails>()
    for (const contact of this.contacts.values()) {
      const jid = this.canonicalJid(contact.jid)
      const existing = contacts.get(jid)
      contacts.set(jid, existing ? mergeContactDetails(existing, contact) : { ...contact, jid })
    }
    this.contacts.clear()
    for (const [jid, contact] of contacts) this.contacts.set(jid, contact)

    const names = new Map<string, string>()
    for (const [jid, name] of this.contactNames) {
      const canonical = this.canonicalJid(jid)
      if (!names.has(canonical)) names.set(canonical, name)
    }
    this.contactNames.clear()
    for (const [jid, name] of names) this.contactNames.set(jid, name)
  }

  /** Load persisted names/unread, then derive chat summaries from the message log. */
  async load(): Promise<void> {
    const snapshot = this.readSnapshot()
    for (const [alias, canonical] of Object.entries(snapshot?.aliases ?? {})) {
      this.aliases.set(alias, canonical)
    }
    for (const [jid, name] of Object.entries(snapshot?.names ?? {})) {
      this.contactNames.set(jid, name)
    }
    for (const c of snapshot?.contacts ?? []) {
      this.contacts.set(c.jid, c)
    }
    for (const c of snapshot?.chats ?? []) {
      this.chats.set(c.jid, { ...c })
    }
    for (const [jid, count] of Object.entries(snapshot?.unread ?? {})) {
      const chat = this.chats.get(jid)
      if (chat) chat.unread = count
    }
    // Merge chats/contacts that persisted aliases now identify as one person.
    this.reindexAliases()

    if (!existsSync(this.messagesFile)) return

    await this.stream((record) => {
      // Status/broadcast and protocol-only records are not conversations.
      if (isIgnoredJid(record.chat) || isNoiseType(record.type)) return
      const chatJid = this.canonicalJid(record.chat)
      const existing = this.chats.get(chatJid)
      if (!existing) {
        this.chats.set(chatJid, {
          jid: chatJid,
          // Contact records win, but the log carries a name too.
          name: this.contactNames.get(chatJid) ?? record.chatName ?? null,
          isGroup: isGroupJid(chatJid),
          lastTs: record.ts,
          lastText: record.text,
          unread: 0,
        })
        return
      }
      if (record.ts >= existing.lastTs) {
        existing.lastTs = record.ts
        existing.lastText = record.text
      }
      if (!existing.name && record.chatName) existing.name = record.chatName
    })
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
    // Persist under the canonical identity so a person never spans two chats.
    const chat = this.canonicalJid(record.chat)
    const from = this.canonicalJid(record.from)
    const normalized: MessageRecord =
      chat === record.chat && from === record.from ? record : { ...record, chat, from }

    const dedupeKey = `${normalized.chat}\u0000${normalized.id}`
    if (this.recentIds.has(dedupeKey)) return false
    this.rememberId(dedupeKey)

    ensureParentDir(this.messagesFile)
    appendFileSync(this.messagesFile, `${JSON.stringify(normalized)}\n`, { mode: 0o600 })

    const existing = this.chats.get(normalized.chat)
    if (existing) {
      if (normalized.ts >= existing.lastTs) {
        existing.lastTs = normalized.ts
        existing.lastText = normalized.text
      }
      if (!normalized.fromMe) existing.unread += 1
      if (normalized.chatName) existing.name = normalized.chatName
    } else {
      this.chats.set(normalized.chat, {
        jid: normalized.chat,
        name: normalized.chatName ?? this.contactNames.get(normalized.chat) ?? null,
        isGroup: isGroupJid(normalized.chat),
        lastTs: normalized.ts,
        lastText: normalized.text,
        unread: normalized.fromMe ? 0 : 1,
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
    const canonical = this.canonicalJid(jid)
    const existing = this.contacts.get(canonical)
    const fullName = data.fullName && data.fullName.trim() !== '' ? data.fullName.trim() : existing?.name ?? null
    const notify = data.notify && data.notify.trim() !== '' ? data.notify.trim() : existing?.notify ?? null
    const isGroup = isGroupJid(canonical)
    const phone = isGroup ? null : numberFromJid(canonical)

    const updated: ContactDetails = {
      jid: canonical,
      name: fullName,
      notify,
      phone,
      isGroup,
    }
    this.contacts.set(canonical, updated)

    // Full name always takes priority over push name / notify
    const bestName = fullName ?? notify
    if (bestName) {
      this.contactNames.set(canonical, bestName)
      const chat = this.chats.get(canonical)
      if (chat) {
        if (fullName || !chat.name) chat.name = bestName
      }
    }
    this.scheduleSnapshot()
  }

  setGroupName(jid: string, subject: string): void {
    const canonical = this.canonicalJid(jid)
    const clean = subject.trim()
    if (!clean) return
    this.contactNames.set(canonical, clean)
    this.contacts.set(canonical, {
      jid: canonical,
      name: clean,
      notify: null,
      phone: null,
      isGroup: true,
    })
    const chat = this.chats.get(canonical)
    if (chat) {
      chat.name = clean
      chat.isGroup = true
    } else {
      this.chats.set(canonical, {
        jid: canonical,
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
    const canonical = this.canonicalJid(jid)
    const existing = this.chats.get(canonical)
    const isGroup = isGroupJid(canonical)
    const name = options.name ?? this.contactNames.get(canonical) ?? existing?.name ?? null
    if (!existing) {
      this.chats.set(canonical, {
        jid: canonical,
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
    const canonical = this.canonicalJid(jid)
    return this.contactNames.get(canonical) ?? this.chats.get(canonical)?.name ?? null
  }

  contact(jid: string): ContactDetails | undefined {
    return this.contacts.get(this.canonicalJid(jid))
  }

  listContacts(query: { search?: string; limit?: number } = {}): ContactDetails[] {
    // Anonymous LID entries with no name are group-member noise, not contacts.
    let list = [...this.contacts.values()].filter(
      (c) => !(isLidJid(c.jid) && !c.name && !c.notify),
    )
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
    return this.chats.get(this.canonicalJid(jid))
  }

  listChats(query: ChatQuery = {}): ChatSummary[] {
    let items = [...this.chats.values()]
      .filter((chat) => !isIgnoredJid(chat.jid))
      .filter((chat) => this.selfJid === null || this.canonicalJid(chat.jid) !== this.selfJid)
      .map((chat) => {
        const resolvedName =
          this.contactNames.get(chat.jid) ??
          this.contacts.get(chat.jid)?.name ??
          this.contacts.get(chat.jid)?.notify ??
          chat.name
        return resolvedName !== chat.name ? { ...chat, name: resolvedName } : chat
      })
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
      if (isIgnoredJid(chat.jid)) continue
      const resolvedName =
        this.contactNames.get(chat.jid) ??
        this.contacts.get(chat.jid)?.name ??
        this.contacts.get(chat.jid)?.notify ??
        chat.name
      map.set(chat.jid, {
        jid: chat.jid,
        name: displayNameFor(chat.jid, resolvedName),
        isGroup: chat.isGroup,
      })
    }
    for (const contact of this.contacts.values()) {
      if (isIgnoredJid(contact.jid) || map.has(contact.jid)) continue
      map.set(contact.jid, {
        jid: contact.jid,
        name: displayNameFor(contact.jid, contact.name ?? contact.notify),
        isGroup: contact.isGroup,
      })
    }
    // Alternate identities resolve to the same person but never participate in
    // name matching (name is null), so explicit `<id>@lid` refs still work.
    for (const [alias, canonical] of this.aliases) {
      if (alias === canonical || map.has(alias)) continue
      const target = map.get(canonical)
      if (target) map.set(alias, { jid: alias, name: null, isGroup: target.isGroup })
    }
    return [...map.values()]
  }

  /** Read messages from the log, newest last. Scans the whole file. */
  async messages(query: ReadQuery = {}): Promise<MessageRecord[]> {
    const byId = new Map<string, MessageRecord>()
    const targetChat = query.chat ? this.canonicalJid(query.chat) : null
    const targetFrom = query.from ? this.canonicalJid(query.from) : null
    await this.stream((record) => {
      if (isIgnoredJid(record.chat) || isNoiseType(record.type)) return
      if (targetChat && this.canonicalJid(record.chat) !== targetChat) return
      if (targetFrom && this.canonicalJid(record.from) !== targetFrom) return
      if (query.since !== undefined && record.ts < query.since) return
      if (query.before !== undefined && record.ts >= query.before) return
      const enriched: MessageRecord = {
        ...record,
        chat: this.canonicalJid(record.chat),
        from: this.canonicalJid(record.from),
        chatName: record.chatName ?? this.contactName(record.chat) ?? null,
        fromName: record.fromName ?? this.contactName(record.from) ?? null,
      }
      byId.set(`${enriched.chat}\u0000${record.id}`, enriched)
    })

    const ordered = [...byId.values()].sort((a, b) => a.ts - b.ts)
    const limit = query.limit ?? 50
    return limit > 0 ? ordered.slice(-limit) : ordered
  }

  async search(text: string, query: ReadQuery = {}): Promise<MessageRecord[]> {
    const needle = text.toLowerCase()
    const matches: MessageRecord[] = []
    const seen = new Set<string>()
    const targetChat = query.chat ? this.canonicalJid(query.chat) : null
    await this.stream((record) => {
      if (isIgnoredJid(record.chat) || isNoiseType(record.type)) return
      if (targetChat && this.canonicalJid(record.chat) !== targetChat) return
      if (query.since !== undefined && record.ts < query.since) return
      if (!record.text.toLowerCase().includes(needle)) return
      const chat = this.canonicalJid(record.chat)
      const key = `${chat}\u0000${record.id}`
      if (seen.has(key)) return
      seen.add(key)
      matches.push({ ...record, chat })
    })
    matches.sort((a, b) => b.ts - a.ts)
    const limit = query.limit ?? 50
    return limit > 0 ? matches.slice(0, limit) : matches
  }

  markRead(jid: string): void {
    const chat = this.chats.get(this.canonicalJid(jid))
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
      aliases: Object.fromEntries([...this.aliases].filter(([jid, canonical]) => jid !== canonical)),
    }
    try {
      ensurePrivateDir(dirname(this.snapshotFile))
      writeFileAtomic(this.snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`)
    } catch {
      // Snapshots are a cache; failure must never break message delivery.
    }
  }
}
