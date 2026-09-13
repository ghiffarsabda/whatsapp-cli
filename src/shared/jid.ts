import { parsePhoneNumberFromString } from 'libphonenumber-js'

export const USER_SERVER = 's.whatsapp.net'
export const GROUP_SERVER = 'g.us'
export const LID_SERVER = 'lid'
export const STATUS_BROADCAST = 'status@broadcast'

export interface ChatCandidate {
  jid: string
  name: string | null
  isGroup: boolean
}

export type ResolveResult =
  | { ok: true; jid: string; via: 'jid' | 'phone' | 'name' | 'search' }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: ChatCandidate[] }

export function isGroupJid(jid: string): boolean {
  return jid.endsWith(`@${GROUP_SERVER}`)
}

export function isUserJid(jid: string): boolean {
  return jid.endsWith(`@${USER_SERVER}`) || jid.endsWith(`@${LID_SERVER}`)
}

/** A phone-number JID, e.g. `628123@s.whatsapp.net` (as opposed to a LID). */
export function isPnJid(jid: string): boolean {
  return jid.endsWith(`@${USER_SERVER}`)
}

/** An anonymous linked-ID JID, e.g. `123456@lid`. */
export function isLidJid(jid: string): boolean {
  return jid.endsWith(`@${LID_SERVER}`)
}

export function isBroadcastJid(jid: string): boolean {
  return jid === STATUS_BROADCAST || jid.endsWith('@broadcast')
}

/** Chats we never ingest or list: status updates and broadcast lists. */
export function isIgnoredJid(jid: string): boolean {
  return isBroadcastJid(jid) || jid === 'status@broadcast'
}

/** Bare local part of a user JID, e.g. `6281234@s.whatsapp.net` -> `6281234`. */
export function numberFromJid(jid: string): string | null {
  if (!isUserJid(jid)) return null
  const at = jid.indexOf('@')
  return at > 0 ? jid.slice(0, at) : null
}

/**
 * Normalize a human-entered phone number to E.164 digits (no `+`).
 * Returns null when the input is not a parseable phone number.
 */
export function normalizePhone(input: string, defaultCountry?: string): string | null {
  const cleaned = input.replace(/[\s()\-.]/g, '')
  if (!/^\+?\d{6,20}$/.test(cleaned)) return null
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry as never)
  if (!parsed || !parsed.isValid()) {
    // Fall back to the raw digits so unparseable-but-numeric input still works.
    const digits = cleaned.replace(/^\+/, '')
    return digits.length >= 6 ? digits : null
  }
  return parsed.number.replace(/^\+/, '')
}

export function phoneToJid(phone: string, defaultCountry?: string): string | null {
  const digits = normalizePhone(phone, defaultCountry)
  return digits === null ? null : `${digits}@${USER_SERVER}`
}

export function looksLikePhone(input: string, defaultCountry?: string): boolean {
  return normalizePhone(input, defaultCountry) !== null
}

/**
 * Resolve what a human or agent typed into a JID.
 * Order: exact JID -> phone number -> exact name -> case-insensitive substring.
 */
export function resolveChatRef(
  ref: string,
  candidates: ChatCandidate[],
  defaultCountry?: string,
): ResolveResult {
  const trimmed = ref.trim()
  if (trimmed === '') return { ok: false, reason: 'not_found', candidates: [] }

  const lower = trimmed.toLowerCase()

  if (trimmed.includes('@')) {
    const exactJid = candidates.find((c) => c.jid.toLowerCase() === lower)
    if (exactJid) return { ok: true, jid: exactJid.jid, via: 'jid' }
  }

  const phone = normalizePhone(trimmed, defaultCountry)
  if (phone !== null) {
    const target = `${phone}@${USER_SERVER}`
    const byPhone = candidates.find((c) => {
      const candidateNumber = numberFromJid(c.jid)
      if (candidateNumber === null) return false
      return candidateNumber === phone || normalizePhone(candidateNumber, defaultCountry) === phone
    })
    // A number we have never seen is still addressable: synthesize the JID.
    if (!byPhone) return { ok: true, jid: target, via: 'phone' }
    return { ok: true, jid: byPhone.jid, via: 'phone' }
  }

  const exactName = candidates.filter((c) => (c.name ?? '').toLowerCase() === lower)
  if (exactName.length === 1) return { ok: true, jid: exactName[0].jid, via: 'name' }
  if (exactName.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: exactName }
  }

  const partial = candidates.filter((c) => (c.name ?? '').toLowerCase().includes(lower))
  if (partial.length === 1) return { ok: true, jid: partial[0].jid, via: 'search' }
  if (partial.length > 1) return { ok: false, reason: 'ambiguous', candidates: partial }

  return { ok: false, reason: 'not_found', candidates: [] }
}

/** Best-effort display name for a JID when we have no contact record. */
export function fallbackName(jid: string): string | null {
  const number = numberFromJid(jid)
  if (number !== null) return `+${number}`
  return isGroupJid(jid) ? 'group' : null
}
