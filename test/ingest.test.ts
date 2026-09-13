import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contentTypeOf,
  isNoiseContent,
  placeholderFor,
  recordFromMessage,
  textFromContent,
  toEpochSeconds,
  unwrapContent,
  type IncomingMessage,
} from '../src/daemon/ingest.js'

test('extracts conversation text', () => {
  assert.equal(textFromContent({ conversation: 'hello' }), 'hello')
})

test('extracts extended text', () => {
  assert.equal(textFromContent({ extendedTextMessage: { text: 'quoted reply' } }), 'quoted reply')
})

test('falls back to media captions', () => {
  assert.equal(textFromContent({ imageMessage: { caption: 'look at this' } }), 'look at this')
  assert.equal(textFromContent({ videoMessage: { caption: 'vid' } }), 'vid')
})

test('returns null when there is no text', () => {
  assert.equal(textFromContent({ imageMessage: {} }), null)
  assert.equal(textFromContent(null), null)
  assert.equal(textFromContent({ conversation: '   ' }), null)
})

test('unwraps envelopes to reach the payload', () => {
  const wrapped = { ephemeralMessage: { message: { imageMessage: { caption: 'inside' } } } }
  assert.equal(textFromContent(wrapped), 'inside')
  assert.equal(contentTypeOf(wrapped), 'imageMessage')

  const doubleWrapped = {
    viewOnceMessage: { message: { ephemeralMessage: { message: { conversation: 'deep' } } } },
  }
  assert.equal(textFromContent(doubleWrapped), 'deep')
})

test('placeholder names the media type', () => {
  assert.equal(placeholderFor({ imageMessage: {} }), '[image]')
  assert.equal(placeholderFor({ audioMessage: {} }), '[audio]')
  assert.equal(placeholderFor({ stickerMessage: {} }), '[sticker]')
  // Unknown but plausibly-messaged keys keep their name for future-proofing.
  assert.equal(placeholderFor({ futureThingMessage: {} }), '[futureThingMessage]')
  // Genuinely unrecognisable content degrades to a generic marker.
  assert.equal(placeholderFor({ nonsense: {} }), '[unknown]')
})

test('toEpochSeconds accepts numbers, bigints and Long-like values', () => {
  assert.equal(toEpochSeconds(1700000000), 1700000000)
  assert.equal(toEpochSeconds(1700000000n), 1700000000)
  assert.equal(toEpochSeconds({ toNumber: () => 1700000001 }), 1700000001)
  assert.equal(typeof toEpochSeconds(null), 'number')
})

test('recordFromMessage maps a direct message', () => {
  const message: IncomingMessage = {
    key: { id: 'ABC', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: { conversation: 'hi there' },
    messageTimestamp: 1700000000,
    pushName: 'Budi',
  }
  const record = recordFromMessage(message, { meJid: '628999@s.whatsapp.net' })
  assert.equal(record?.id, 'ABC')
  assert.equal(record?.chat, '628111@s.whatsapp.net')
  assert.equal(record?.from, '628111@s.whatsapp.net')
  assert.equal(record?.fromName, 'Budi')
  assert.equal(record?.chatName, 'Budi')
  assert.equal(record?.fromMe, false)
  assert.equal(record?.type, 'text')
  assert.equal(record?.text, 'hi there')
  assert.equal(record?.ts, 1700000000)
})

test('recordFromMessage handles voice notes and duration', () => {
  const message: IncomingMessage = {
    key: { id: 'V1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: { audioMessage: { seconds: 75, ptt: true, mimetype: 'audio/ogg; codecs=opus' } },
    messageTimestamp: 1700000020,
    pushName: 'Budi',
  }
  const record = recordFromMessage(message)
  assert.equal(record?.type, 'audioMessage')
  assert.equal(record?.text, '[voice note 1:15]')
  assert.equal(record?.duration, 75)
  assert.equal(record?.mimetype, 'audio/ogg; codecs=opus')
})

test('recordFromMessage attributes group messages to the participant', () => {
  const message: IncomingMessage = {
    key: {
      id: 'G1',
      remoteJid: '120363@g.us',
      fromMe: false,
      participant: '628222@s.whatsapp.net',
    },
    message: { conversation: 'group hello' },
    messageTimestamp: 1700000005,
    pushName: 'Ani',
  }
  const record = recordFromMessage(message)
  assert.equal(record?.chat, '120363@g.us')
  assert.equal(record?.from, '628222@s.whatsapp.net')
})

test('recordFromMessage marks outgoing messages as me', () => {
  const message: IncomingMessage = {
    key: { id: 'M1', remoteJid: '628111@s.whatsapp.net', fromMe: true },
    message: { conversation: 'sent by me' },
    messageTimestamp: 1700000009,
  }
  const record = recordFromMessage(message, { meJid: '628999@s.whatsapp.net', meName: 'Me' })
  assert.equal(record?.fromMe, true)
  assert.equal(record?.from, '628999@s.whatsapp.net')
  assert.equal(record?.fromName, 'Me')
})

test('recordFromMessage stores a placeholder for media', () => {
  const message: IncomingMessage = {
    key: { id: 'IMG', remoteJid: '628111@s.whatsapp.net' },
    message: { imageMessage: {} },
    messageTimestamp: 1700000010,
  }
  const record = recordFromMessage(message)
  assert.equal(record?.type, 'imageMessage')
  assert.equal(record?.text, '[image]')
})

test('recordFromMessage captures the quoted message id', () => {
  const message: IncomingMessage = {
    key: { id: 'R1', remoteJid: '628111@s.whatsapp.net' },
    message: { extendedTextMessage: { text: 'replying', contextInfo: { stanzaId: 'ORIGINAL' } } },
    messageTimestamp: 1700000011,
  }
  assert.equal(recordFromMessage(message)?.replyTo, 'ORIGINAL')
})

test('recordFromMessage rejects unusable messages', () => {
  assert.equal(recordFromMessage({ key: { id: 'x' } }), null)
  assert.equal(recordFromMessage({ key: { remoteJid: '6281@s.whatsapp.net' } }), null)
})

test('unwrapContent is safe on deeply nested and empty input', () => {
  assert.equal(unwrapContent(null), null)
  assert.equal(unwrapContent(undefined), null)
  assert.deepEqual(unwrapContent({ conversation: 'x' }), { conversation: 'x' })
})

test('isNoiseContent identifies internal protocol envelopes', () => {
  assert.equal(isNoiseContent({ conversation: 'hi' }), false)
  assert.equal(isNoiseContent({ imageMessage: {} }), false)
  assert.equal(isNoiseContent({ senderKeyDistributionMessage: {} }), true)
  assert.equal(isNoiseContent({ protocolMessage: {} }), true)
  assert.equal(isNoiseContent(null), true)
})

test('recordFromMessage skips status broadcasts and protocol noise', () => {
  assert.equal(
    recordFromMessage({
      key: { id: 'S1', remoteJid: 'status@broadcast' },
      message: { conversation: 'my status' },
    }),
    null,
  )
  assert.equal(
    recordFromMessage({
      key: { id: 'K1', remoteJid: '120363@g.us' },
      message: { senderKeyDistributionMessage: { groupId: '120363@g.us' } },
    }),
    null,
  )
  assert.equal(
    recordFromMessage({
      key: { id: 'P1', remoteJid: '628111@s.whatsapp.net' },
      message: { protocolMessage: { type: 3 } },
    }),
    null,
  )
  assert.equal(
    recordFromMessage({
      key: { id: 'U1', remoteJid: '628111@s.whatsapp.net' },
      message: { messageContextInfo: { deviceListMetadata: {} } },
    }),
    null,
  )
})

test('recordFromMessage keeps documents and captures the file name', () => {
  const message: IncomingMessage = {
    key: { id: 'DOC', remoteJid: '628111@s.whatsapp.net' },
    message: { documentMessage: { fileName: 'invoice.pdf', mimetype: 'application/pdf' } },
    messageTimestamp: 1700000000,
  }
  const record = recordFromMessage(message)
  assert.equal(record?.type, 'documentMessage')
  assert.equal(record?.text, '[document: invoice.pdf]')
  assert.equal(record?.fileName, 'invoice.pdf')
  assert.equal(record?.mimetype, 'application/pdf')
})
