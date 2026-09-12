import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isBroadcastJid,
  isGroupJid,
  isUserJid,
  normalizePhone,
  numberFromJid,
  phoneToJid,
  resolveChatRef,
  type ChatCandidate,
} from '../src/shared/jid.js'

const candidates: ChatCandidate[] = [
  { jid: '628111111111@s.whatsapp.net', name: 'Budi', isGroup: false },
  { jid: '628222222222@s.whatsapp.net', name: 'Budi Santoso', isGroup: false },
  { jid: '628333333333@s.whatsapp.net', name: 'Ani', isGroup: false },
  { jid: '120363000000000000@g.us', name: 'Team Standup', isGroup: true },
]

test('jid classification', () => {
  assert.equal(isUserJid('6281@s.whatsapp.net'), true)
  assert.equal(isUserJid('6281@lid'), true)
  assert.equal(isUserJid('123@g.us'), false)
  assert.equal(isGroupJid('123@g.us'), true)
  assert.equal(isBroadcastJid('status@broadcast'), true)
  assert.equal(isBroadcastJid('123@broadcast'), true)
  assert.equal(isBroadcastJid('6281@s.whatsapp.net'), false)
})

test('numberFromJid only extracts for user jids', () => {
  assert.equal(numberFromJid('628123456789@s.whatsapp.net'), '628123456789')
  assert.equal(numberFromJid('123@g.us'), null)
})

test('normalizePhone handles separators, +, and country codes', () => {
  assert.equal(normalizePhone('+62 812-3456-789'), '628123456789')
  assert.equal(normalizePhone('+628123456789'), '628123456789')
  assert.equal(normalizePhone('not a phone'), null)
  assert.equal(normalizePhone(''), null)
})

test('phoneToJid builds a user jid', () => {
  assert.equal(phoneToJid('+62 812 3456 789'), '628123456789@s.whatsapp.net')
  assert.equal(phoneToJid('nope'), null)
})

test('resolveChatRef prefers exact jid', () => {
  const result = resolveChatRef('628333333333@s.whatsapp.net', candidates)
  assert.deepEqual(result, { ok: true, jid: '628333333333@s.whatsapp.net', via: 'jid' })
})

test('resolveChatRef resolves a known phone number to its jid', () => {
  const result = resolveChatRef('+62 811-1111-111', candidates)
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.jid, '628111111111@s.whatsapp.net')
})

test('resolveChatRef synthesizes a jid for an unknown number', () => {
  const result = resolveChatRef('+62 899 0000 111', candidates)
  assert.deepEqual(result, { ok: true, jid: '628990000111@s.whatsapp.net', via: 'phone' })
})

test('resolveChatRef matches an exact name', () => {
  const result = resolveChatRef('Ani', candidates)
  assert.deepEqual(result, { ok: true, jid: '628333333333@s.whatsapp.net', via: 'name' })
})

test('resolveChatRef reports ambiguity instead of guessing', () => {
  // "Budi" is an exact match for one and a substring of another.
  const result = resolveChatRef('Budi', candidates)
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.jid, '628111111111@s.whatsapp.net')

  // A bare substring matching two entries must be ambiguous.
  const partial = resolveChatRef('budi', [
    { jid: 'a@s.whatsapp.net', name: 'Budi One', isGroup: false },
    { jid: 'b@s.whatsapp.net', name: 'Budi Two', isGroup: false },
  ])
  assert.equal(partial.ok, false)
  assert.equal(partial.ok === false && partial.reason, 'ambiguous')
  assert.equal(partial.ok === false && partial.candidates.length, 2)
})

test('resolveChatRef reports not found', () => {
  const result = resolveChatRef('nobody', candidates)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'not_found')
})

test('resolveChatRef resolves group names', () => {
  const result = resolveChatRef('team standup', candidates)
  assert.deepEqual(result, { ok: true, jid: '120363000000000000@g.us', via: 'name' })
})
