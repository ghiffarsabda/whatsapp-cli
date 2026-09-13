import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notificationCommand } from '../src/shared/notify.js'

test('linux notifications use notify-send with the title and body', () => {
  const spec = notificationCommand('linux', 'Budi', 'hello there')
  assert.equal(spec?.cmd, 'notify-send')
  assert.deepEqual(spec?.args, ['--app-name=whatsapp-cli', 'Budi', 'hello there'])
})

test('macOS notifications use osascript', () => {
  const spec = notificationCommand('darwin', 'Budi', 'hi')
  assert.equal(spec?.cmd, 'osascript')
  assert.match(spec?.args[1] ?? '', /display notification "hi" with title "Budi"/)
})

test('windows has no native notifier, so the caller rings the bell', () => {
  assert.equal(notificationCommand('win32', 'Budi', 'hi'), null)
})
