import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hintsFor, resolveKey, type KeyLike } from '../src/tui/keys.js'

const noKey: KeyLike = {}

test('ctrl+c quits from every pane', () => {
  for (const pane of ['list', 'messages', 'composer'] as const) {
    assert.deepEqual(resolveKey('c', { ctrl: true }, pane), { type: 'quit' })
  }
})

test('tab cycles panes from every pane', () => {
  for (const pane of ['list', 'messages', 'composer'] as const) {
    assert.deepEqual(resolveKey('', { tab: true }, pane), { type: 'focus-next' })
  }
})

test('list navigation', () => {
  assert.deepEqual(resolveKey('j', noKey, 'list'), { type: 'select-delta', delta: 1 })
  assert.deepEqual(resolveKey('', { downArrow: true }, 'list'), { type: 'select-delta', delta: 1 })
  assert.deepEqual(resolveKey('k', noKey, 'list'), { type: 'select-delta', delta: -1 })
  assert.deepEqual(resolveKey('', { upArrow: true }, 'list'), { type: 'select-delta', delta: -1 })
  assert.deepEqual(resolveKey('g', noKey, 'list'), { type: 'select-first' })
  assert.deepEqual(resolveKey('G', { shift: true }, 'list'), { type: 'select-last' })
})

test('enter and l open the selected chat', () => {
  assert.deepEqual(resolveKey('', { return: true }, 'list'), { type: 'open-chat' })
  assert.deepEqual(resolveKey('l', noKey, 'list'), { type: 'open-chat' })
})

test('q quits from the list and message panes', () => {
  assert.deepEqual(resolveKey('q', noKey, 'list'), { type: 'quit' })
  assert.deepEqual(resolveKey('q', noKey, 'messages'), { type: 'quit' })
})

test('q is typed into the composer, not treated as quit', () => {
  assert.equal(resolveKey('q', noKey, 'composer'), null)
  assert.equal(resolveKey('x', noKey, 'composer'), null)
  assert.equal(resolveKey('', { return: true }, 'composer'), null)
})

test('escape leaves the composer', () => {
  assert.deepEqual(resolveKey('', { escape: true }, 'composer'), { type: 'focus-list' })
})

test('message pane scrolling', () => {
  assert.deepEqual(resolveKey('j', noKey, 'messages'), { type: 'scroll-delta', delta: -1 })
  assert.deepEqual(resolveKey('k', noKey, 'messages'), { type: 'scroll-delta', delta: 1 })
  assert.deepEqual(resolveKey('', { pageUp: true }, 'messages'), { type: 'scroll-delta', delta: 10 })
  assert.deepEqual(resolveKey('', { pageDown: true }, 'messages'), { type: 'scroll-delta', delta: -10 })
})

test('unhandled keys resolve to null rather than a wrong action', () => {
  assert.equal(resolveKey('z', noKey, 'list'), null)
  assert.equal(resolveKey('z', noKey, 'messages'), null)
  assert.equal(resolveKey('', noKey, 'list'), null)
})

test('load-older and jump-to-newest are reachable', () => {
  assert.deepEqual(resolveKey('o', noKey, 'messages'), { type: 'load-older' })
  assert.deepEqual(resolveKey('G', { shift: true }, 'messages'), { type: 'scroll-newest' })
})

test('writing is reachable from both panes', () => {
  assert.deepEqual(resolveKey('i', noKey, 'messages'), { type: 'focus-composer' })
  assert.deepEqual(resolveKey('/', noKey, 'list'), { type: 'focus-composer' })
})

test('hints mention the newest-chat jump only when scrolled back', () => {
  assert.match(hintsFor('messages', false), /G newest/)
  assert.doesNotMatch(hintsFor('messages', true), /G newest/)
  assert.match(hintsFor('composer', true), /enter send/)
  assert.match(hintsFor('list', true), /enter open/)
})
