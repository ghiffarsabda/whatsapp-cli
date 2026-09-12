import assert from 'node:assert/strict'
import { test } from 'node:test'
// Imported explicitly: the test runner's JSX transform uses the classic
// runtime here, since these files sit outside the tsconfig `include`.
import React from 'react'
import { render } from 'ink-testing-library'
import type { ChatSummary, MessageRecord } from '../src/shared/protocol.js'
import { ChatList } from '../src/tui/components/ChatList.js'
import { MessagePane } from '../src/tui/components/MessagePane.js'
import { Footer } from '../src/tui/components/Footer.js'
import { Composer } from '../src/tui/components/Composer.js'
import { ContactSearch } from '../src/tui/components/ContactSearch.js'

function msg(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 'm1',
    chat: '628111@s.whatsapp.net',
    chatName: 'Budi',
    from: '628111@s.whatsapp.net',
    fromName: 'Budi',
    fromMe: false,
    ts: 1757600000,
    type: 'text',
    text: 'hello there',
    replyTo: null,
    ...overrides,
  }
}

function chat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    jid: '628111@s.whatsapp.net',
    name: 'Budi',
    isGroup: false,
    lastTs: 1757600000,
    lastText: 'hello there',
    unread: 0,
    ...overrides,
  }
}

test('ChatList renders names and unread badges', () => {
  const { lastFrame } = render(
    <ChatList
      chats={[
        chat({ jid: 'a@s.whatsapp.net', name: 'Budi', unread: 2 }),
        chat({ jid: 'b@g.us', name: 'Team Standup', unread: 0 }),
      ]}
      selectedIndex={0}
      isFocused
      width={34}
      height={10}
    />,
  )
  const frame = lastFrame() ?? ''
  assert.match(frame, /Budi/)
  assert.match(frame, /\(2\)/)
  assert.match(frame, /Team Standup/)
})

test('ChatList shows a marker on the selected row only', () => {
  const { lastFrame } = render(
    <ChatList
      chats={[chat({ jid: 'a@s.whatsapp.net', name: 'Budi' }), chat({ jid: 'b@s.whatsapp.net', name: 'Ani' })]}
      selectedIndex={1}
      isFocused
      width={34}
      height={10}
    />,
  )
  const lines = (lastFrame() ?? '').split('\n')
  const marked = lines.filter((line) => line.includes('▸'))
  assert.equal(marked.length, 1)
  assert.match(marked[0]!, /Ani/)
})

test('ChatList handles an empty list', () => {
  const { lastFrame } = render(
    <ChatList chats={[]} selectedIndex={0} isFocused width={30} height={8} />,
  )
  assert.match(lastFrame() ?? '', /no chats yet/)
})

test('ChatList truncates to the available height', () => {
  const chats = Array.from({ length: 40 }, (_, i) =>
    chat({ jid: `${i}@s.whatsapp.net`, name: `Person ${i}` }),
  )
  const { lastFrame } = render(
    <ChatList chats={chats} selectedIndex={0} isFocused width={30} height={6} />,
  )
  const frame = lastFrame() ?? ''
  // Only a handful of rows fit; the rest must not be drawn.
  assert.doesNotMatch(frame, /Person 30/)
})

test('MessagePane renders sender and body', () => {
  const { lastFrame } = render(
    <MessagePane
      messages={[msg({ id: 'a', text: 'hello there' }), msg({ id: 'b', fromMe: true, text: 'hi back' })]}
      chatName="Budi"
      chatJid="628111@s.whatsapp.net"
      offset={0}
      isFocused
      width={60}
      height={14}
      meName="Me"
    />,
  )
  const frame = lastFrame() ?? ''
  assert.match(frame, /hello there/)
  assert.match(frame, /hi back/)
  assert.match(frame, /Budi/)
  assert.match(frame, /Me/)
})

test('MessagePane reports how much older history is hidden', () => {
  const messages = Array.from({ length: 30 }, (_, i) => msg({ id: `m${i}`, ts: 1757600000 + i }))
  const { lastFrame } = render(
    <MessagePane
      messages={messages}
      chatName="Budi"
      chatJid="628111@s.whatsapp.net"
      offset={0}
      isFocused
      width={60}
      height={8}
      meName="Me"
    />,
  )
  assert.match(lastFrame() ?? '', /older not shown/)
})

test('MessagePane prompts when no chat is open', () => {
  const { lastFrame } = render(
    <MessagePane
      messages={[]}
      chatName={null}
      chatJid={null}
      offset={0}
      isFocused={false}
      width={50}
      height={8}
      meName="Me"
    />,
  )
  assert.match(lastFrame() ?? '', /no chat selected/)
})

test('Composer shows a placeholder when idle', () => {
  const { lastFrame } = render(
    <Composer
      isActive={false}
      width={40}
      placeholder="press i to write"
      onSubmit={() => {}}
      onExit={() => {}}
    />,
  )
  assert.match(lastFrame() ?? '', /press i to write/)
})

test('Composer accepts typed characters and submits on enter', async () => {
  const submitted: string[] = []
  const { stdin, lastFrame } = render(
    <Composer isActive width={40} onSubmit={(text) => submitted.push(text)} onExit={() => {}} />,
  )

  for (const char of 'hi there') stdin.write(char)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.match(lastFrame() ?? '', /hi there/)

  stdin.write('\r')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(submitted, ['hi there'])
  // Buffer is cleared after sending.
  assert.doesNotMatch(lastFrame() ?? '', /hi there/)
})

test('Composer backspace edits the buffer', async () => {
  const { stdin, lastFrame } = render(
    <Composer isActive width={40} onSubmit={() => {}} onExit={() => {}} />,
  )
  for (const char of 'abc') stdin.write(char)
  await new Promise((resolve) => setTimeout(resolve, 50))
  stdin.write('\x7f') // backspace
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.match(lastFrame() ?? '', /ab/)
  assert.doesNotMatch(lastFrame() ?? '', /abc/)
})

test('Composer ignores an empty submission', async () => {
  const submitted: string[] = []
  const { stdin } = render(
    <Composer isActive width={40} onSubmit={(text) => submitted.push(text)} onExit={() => {}} />,
  )
  stdin.write('\r')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(submitted, [])
})

test('Composer reports escape so the caller can leave', async () => {
  let exited = 0
  const { stdin } = render(
    <Composer isActive width={40} onSubmit={() => {}} onExit={() => (exited += 1)} />,
  )
  stdin.write('\x1b')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(exited, 1)
})

test('Footer shows connection state and unread count', () => {
  const { lastFrame } = render(
    <Footer pane="list" atNewest connection="open" unread={3} message={null} width={80} />,
  )
  const frame = lastFrame() ?? ''
  assert.match(frame, /open/)
  assert.match(frame, /3 unread/)
})

test('Footer surfaces a transient status message', () => {
  const { lastFrame } = render(
    <Footer pane="messages" atNewest={false} connection="close" unread={0} message="send failed" width={80} />,
  )
  const frame = lastFrame() ?? ''
  assert.match(frame, /send failed/)
  assert.match(frame, /close/)
  assert.match(frame, /G newest/)
})

test('ContactSearch renders matching contacts and chats', () => {
  const contacts = [
    { jid: '628111@s.whatsapp.net', name: 'Alice Walker', notify: 'Alice', phone: '628111', isGroup: false },
  ]
  const chats = [
    chat({ jid: '1203630@g.us', name: 'Weekend Hikers', isGroup: true }),
  ]
  const { lastFrame } = render(
    <ContactSearch
      contacts={contacts}
      chats={chats}
      width={60}
      height={15}
      onSelect={() => {}}
      onClose={() => {}}
    />,
  )
  const frame = lastFrame() ?? ''
  assert.match(frame, /Search Contacts/)
  assert.match(frame, /Alice Walker/)
  assert.match(frame, /Weekend Hikers/)
  assert.match(frame, /\[GRP\]/)
  assert.match(frame, /\[DIR\]/)
})

test('ContactSearch filters and selects contact on Enter', async () => {
  const contacts = [
    { jid: '628111@s.whatsapp.net', name: 'Alice Walker', notify: 'Alice', phone: '628111', isGroup: false },
    { jid: '628222@s.whatsapp.net', name: 'Bob Builder', notify: 'Bob', phone: '628222', isGroup: false },
  ]
  let selectedJid = ''
  const { stdin } = render(
    <ContactSearch
      contacts={contacts}
      chats={[]}
      width={60}
      height={15}
      onSelect={(jid) => { selectedJid = jid }}
      onClose={() => {}}
    />,
  )
  // Type 'Bob' then wait for state update, then enter
  stdin.write('Bob')
  await new Promise((resolve) => setTimeout(resolve, 50))
  stdin.write('\r')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(selectedJid, '628222@s.whatsapp.net')
})

test('MessagePane renders media indicators for voice notes and images', () => {
  const messages = [
    msg({
      id: 'vn1',
      type: 'audio',
      text: '[voice note 0:42]',
      mediaPath: '/tmp/vn1.ogg',
      duration: 42,
    }),
    msg({
      id: 'img1',
      type: 'image',
      text: '[image photo.jpg]',
      mediaPath: '/tmp/photo.jpg',
    }),
  ]
  const { lastFrame } = render(
    <MessagePane
      messages={messages}
      activeChat={chat()}
      historyOffset={0}
      hiddenOlder={0}
      width={70}
      height={15}
    />,
  )
  const frame = lastFrame() ?? ''
  assert.match(frame, /\[voice note 0:42\]/)
  assert.match(frame, /press 'p' to play/)
  assert.match(frame, /\[image photo.jpg\]/)
  assert.match(frame, /press 'v'/)
})

