import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toErrorPayload } from '../shared/errors.js'
import type { ChatSummary, MeInfo, MessageRecord } from '../shared/protocol.js'
import { call, subscribe, type Subscription } from '../cli/ipc-client.js'
import type { EventFrame } from '../shared/protocol.js'
import { ChatList } from './components/ChatList.js'
import { Composer } from './components/Composer.js'
import { Footer } from './components/Footer.js'
import { MessagePane } from './components/MessagePane.js'
import { resolveKey, type Pane } from './keys.js'
import {
  applyIncomingChat,
  clearUnread,
  indexOfChat,
  mergeMessages,
  moveSelection,
  sortChats,
  unreadTotal,
} from './logic.js'

const PAGE_SIZE = 100
const STATUS_TTL_MS = 4000

export interface AppProps {
  me: MeInfo | null
  initialConnection: string
}

const PANE_ORDER: Pane[] = ['list', 'messages', 'composer']

export function App({ me, initialConnection }: AppProps) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [openChatJid, setOpenChatJid] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [offset, setOffset] = useState(0)
  const [pane, setPane] = useState<Pane>('list')
  const [connection, setConnection] = useState(initialConnection)
  const [status, setStatus] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMoreOlder, setHasMoreOlder] = useState(false)

  // Read inside the input handler without making it a dependency of the handler.
  const openChatRef = useRef<string | null>(null)
  openChatRef.current = openChatJid
  const messagesRef = useRef<MessageRecord[]>([])
  messagesRef.current = messages

  const openChat = useCallback(async (jid: string) => {
    setOpenChatJid(jid)
    setOffset(0)
    setPane('messages')
    try {
      const result = await call<{ messages: MessageRecord[] }>('read', {
        chat: jid,
        limit: PAGE_SIZE,
      })
      setMessages(result.messages)
      setHasMoreOlder(result.messages.length === PAGE_SIZE)
      // `read` marks the chat read on the daemon; mirror that locally.
      setChats((current) => clearUnread(current, jid))
    } catch (error) {
      setStatus(toErrorPayload(error).message)
      setMessages([])
    }
  }, [])

  const loadOlder = useCallback(async () => {
    const jid = openChatRef.current
    const current = messagesRef.current
    if (!jid || current.length === 0 || loadingOlder || !hasMoreOlder) return

    setLoadingOlder(true)
    try {
      const oldest = current[0]!.ts
      const result = await call<{ messages: MessageRecord[] }>('read', {
        chat: jid,
        limit: PAGE_SIZE,
        before: oldest,
      })
      if (result.messages.length > 0) {
        setMessages((existing) => mergeMessages(existing, result.messages))
        // Prepend means the scroll offset must grow to hold the same view.
        setOffset((current) => current + result.messages.length)
      }
      setHasMoreOlder(result.messages.length === PAGE_SIZE)
      setStatus(
        result.messages.length === 0 ? 'no more history' : `loaded ${result.messages.length} older`,
      )
    } catch (error) {
      setStatus(toErrorPayload(error).message)
    } finally {
      setLoadingOlder(false)
    }
  }, [hasMoreOlder, loadingOlder])

  const send = useCallback(async (text: string) => {
    const jid = openChatRef.current
    if (!jid) {
      setStatus('open a chat first')
      return
    }
    try {
      await call('send', { chat: jid, text })
      // The daemon broadcasts the outgoing message back through the
      // subscription, so there is no optimistic insert here.
      setOffset(0)
    } catch (error) {
      setStatus(`send failed: ${toErrorPayload(error).message}`)
    }
  }, [])

  // Initial load plus the single live subscription for every chat.
  useEffect(() => {
    let cancelled = false
    let subscription: Subscription | null = null

    void (async () => {
      try {
        const loaded = await call<{ chats: ChatSummary[] }>('chats', { limit: 200 })
        if (!cancelled) setChats(sortChats(loaded.chats))
      } catch (error) {
        if (!cancelled) setStatus(toErrorPayload(error).message)
      }
    })()

    const onEvent = (frame: EventFrame) => {
      if (frame.event === 'status') {
        const data = frame.data as { connection?: string }
        if (data.connection) setConnection(data.connection)
        return
      }
      if (frame.event !== 'message') return

      const record = frame.data as MessageRecord
      const open = openChatRef.current

      setChats((current) => applyIncomingChat(current, record, open))
      if (record.chat !== open) return

      setMessages((current) => mergeMessages(current, [record]))
      // Stay pinned to the newest unless the viewer has scrolled back, in which
      // case shift the offset so the visible content does not jump.
      setOffset((current) => (current === 0 ? 0 : current + 1))
    }

    subscribe(null, onEvent)
      .then((created) => {
        if (cancelled) created.close()
        else subscription = created
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus(toErrorPayload(error).message)
      })

    return () => {
      cancelled = true
      subscription?.close()
    }
  }, [])

  useEffect(() => {
    if (status === null) return
    const timer = setTimeout(() => setStatus(null), STATUS_TTL_MS)
    return () => clearTimeout(timer)
  }, [status])

  useInput(
    (input, key) => {
      const action = resolveKey(input, key, pane)
      if (!action) return

      switch (action.type) {
        case 'quit':
          exit()
          return
        case 'focus-next': {
          const index = PANE_ORDER.indexOf(pane)
          const next = PANE_ORDER[(index + 1) % PANE_ORDER.length] ?? 'list'
          // Never park focus on an empty message pane.
          setPane(next === 'messages' && !openChatRef.current ? 'list' : next)
          return
        }
        case 'focus-list':
          setPane('list')
          return
        case 'focus-composer':
          if (openChatRef.current) setPane('composer')
          return
        case 'select-delta':
          setSelectedIndex((current) => moveSelection(current, action.delta, chats.length))
          return
        case 'select-first':
          setSelectedIndex(0)
          return
        case 'select-last':
          setSelectedIndex(Math.max(0, chats.length - 1))
          return
        case 'open-chat': {
          const chat = chats[selectedIndex]
          if (chat) void openChat(chat.jid)
          return
        }
        case 'scroll-delta':
          setOffset((current) =>
            Math.min(Math.max(0, current + action.delta), Math.max(0, messagesRef.current.length - 1)),
          )
          return
        case 'scroll-newest':
          setOffset(0)
          return
        case 'load-older':
          void loadOlder()
          return
      }
    },
    { isActive: pane !== 'composer' },
  )

  // Keep the selection pointing at the same chat as the list re-sorts.
  useEffect(() => {
    if (openChatJid === null) return
    setSelectedIndex(indexOfChat(chats, openChatJid))
  }, [chats, openChatJid])

  const layout = useMemo(() => {
    const totalWidth = Math.max(40, columns)
    const listWidth = Math.min(36, Math.max(20, Math.floor(totalWidth * 0.3)))
    const mainHeight = Math.max(6, rows - 4)
    return { listWidth, messageWidth: totalWidth - listWidth, mainHeight }
  }, [columns, rows])

  const window = useMemo(
    () => ({ atNewest: offset === 0 }),
    [offset],
  )

  const selectedChat = chats[selectedIndex]
  const title = selectedChat ? selectedChat.name ?? selectedChat.jid : null

  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="row">
        <ChatList
          chats={chats}
          selectedIndex={selectedIndex}
          isFocused={pane === 'list'}
          width={layout.listWidth}
          height={layout.mainHeight}
        />
        <MessagePane
          messages={messages}
          chatName={title}
          chatJid={openChatJid}
          offset={offset}
          isFocused={pane === 'messages'}
          width={layout.messageWidth}
          height={layout.mainHeight}
          meName={me?.name ?? 'me'}
        />
      </Box>
      <Composer
        isActive={pane === 'composer'}
        width={columns}
        placeholder={
          openChatJid ? 'press i to write' : 'select a chat and press enter to open'
        }
        onSubmit={(text) => void send(text)}
        onExit={() => setPane('list')}
      />
      <Footer
        pane={pane}
        atNewest={window.atNewest}
        connection={connection}
        unread={unreadTotal(chats)}
        message={status}
        width={columns}
      />
      {rows < 8 ? <Text dimColor>terminal too short</Text> : null}
    </Box>
  )
}
