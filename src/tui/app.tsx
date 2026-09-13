import { Box, Text, useApp, useInput, useWindowSize } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toErrorPayload } from '../shared/errors.js'
import { openImageViewer, openPath, playAudio } from '../shared/media-player.js'
import { sendNotification } from '../shared/notify.js'
import type { ChatSummary, ContactSummary, MeInfo, MessageRecord } from '../shared/protocol.js'
import { call, subscribe, type Subscription } from '../cli/ipc-client.js'
import type { EventFrame } from '../shared/protocol.js'
import { ChatList } from './components/ChatList.js'
import { Composer } from './components/Composer.js'
import { ContactSearch } from './components/ContactSearch.js'
import { Footer } from './components/Footer.js'
import { MessagePane } from './components/MessagePane.js'
import { resolveKey, type Pane } from './keys.js'
import {
  applyIncomingChat,
  clearUnread,
  indexOfChat,
  mergeMessages,
  moveSelection,
  nextPane,
  previewText,
  sortChats,
  unreadTotal,
  visibleWindow,
} from './logic.js'

const PAGE_SIZE = 100
const STATUS_TTL_MS = 4000

/** Voice notes and audio are played (`p`), not opened as files (`v`). */
function isAudioPath(path: string): boolean {
  return /\.(ogg|opus|mp3|m4a|wav|aac)$/i.test(path)
}

export interface AppProps {
  me: MeInfo | null
  initialConnection: string
}

export function App({ me, initialConnection }: AppProps) {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()

  const [chats, setChats] = useState<ChatSummary[]>([])
  const [contacts, setContacts] = useState<ContactSummary[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [openChatJid, setOpenChatJid] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [offset, setOffset] = useState(0)
  const [pane, setPane] = useState<Pane>('list')
  const [connection, setConnection] = useState(initialConnection)
  const [status, setStatus] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [isSearchingContacts, setIsSearchingContacts] = useState(false)

  // Read inside the input handler without making it a dependency of the handler.
  const openChatRef = useRef<string | null>(null)
  openChatRef.current = openChatJid
  const messagesRef = useRef<MessageRecord[]>([])
  messagesRef.current = messages
  // Guards against a slow `read` for a previous chat landing after a newer one.
  const readTokenRef = useRef(0)
  const prevConnectionRef = useRef(initialConnection)
  const contactMapRef = useRef<Record<string, string>>({})

  const loadContacts = useCallback(async () => {
    try {
      const res = await call<{ contacts: ContactSummary[] }>('contacts', {})
      setContacts(res.contacts)
    } catch {
      // Best effort
    }
  }, [])

  const loadChats = useCallback(async () => {
    try {
      // No limit: every known chat (including quiet groups) must be reachable.
      const loaded = await call<{ chats: ChatSummary[] }>('chats', {})
      setChats(sortChats(loaded.chats))
    } catch (error) {
      setStatus(toErrorPayload(error).message)
    }
  }, [])

  const contactMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const c of contacts) {
      const name = c.name ?? c.notify
      if (name) map[c.jid] = name
    }
    for (const ch of chats) {
      if (ch.name && !map[ch.jid]) map[ch.jid] = ch.name
    }
    return map
  }, [contacts, chats])
  contactMapRef.current = contactMap

  const openChat = useCallback(async (jid: string) => {
    const token = readTokenRef.current + 1
    readTokenRef.current = token
    setOpenChatJid(jid)
    setOffset(0)
    // Drop the previous chat's messages immediately: never show a stale
    // conversation under the new title while the read is in flight.
    setMessages([])
    setHasMoreOlder(false)
    setPane('messages')
    try {
      const result = await call<{ messages: MessageRecord[] }>('read', {
        chat: jid,
        limit: PAGE_SIZE,
      })
      if (readTokenRef.current !== token) return
      setMessages(result.messages)
      setHasMoreOlder(result.messages.length === PAGE_SIZE)
      // `read` marks the chat read on the daemon; mirror that locally.
      setChats((current) => clearUnread(current, jid))
    } catch (error) {
      if (readTokenRef.current !== token) return
      setStatus(toErrorPayload(error).message)
      setMessages([])
    }
  }, [])

  const loadOlder = useCallback(async () => {
    const jid = openChatRef.current
    const current = messagesRef.current
    if (!jid || current.length === 0 || loadingOlder || !hasMoreOlder) return

    const token = readTokenRef.current
    setLoadingOlder(true)
    try {
      const oldest = current[0]!.ts
      const result = await call<{ messages: MessageRecord[] }>('read', {
        chat: jid,
        limit: PAGE_SIZE,
        before: oldest,
      })
      if (readTokenRef.current !== token) return
      if (result.messages.length > 0) {
        setMessages((existing) => mergeMessages(existing, result.messages))
        setOffset((cur) => cur + result.messages.length)
      }
      setHasMoreOlder(result.messages.length === PAGE_SIZE)
      setStatus(
        result.messages.length === 0 ? 'no more history' : `loaded ${result.messages.length} older`,
      )
    } catch (error) {
      if (readTokenRef.current !== token) return
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
      setOffset(0)
    } catch (error) {
      setStatus(`send failed: ${toErrorPayload(error).message}`)
    }
  }, [])

  // Initial load plus live subscription for all chats.
  useEffect(() => {
    let cancelled = false
    let subscription: Subscription | null = null

    void (async () => {
      try {
        const loaded = await call<{ chats: ChatSummary[] }>('chats', {})
        if (!cancelled) setChats(sortChats(loaded.chats))
        const cLoaded = await call<{ contacts: ContactSummary[] }>('contacts', {})
        if (!cancelled) setContacts(cLoaded.contacts)
      } catch (error) {
        if (!cancelled) setStatus(toErrorPayload(error).message)
      }
    })()

    const onEvent = (frame: EventFrame) => {
      if (frame.event === 'status') {
        const data = frame.data as { connection?: string }
        if (data.connection) {
          const wasOpen = prevConnectionRef.current === 'open'
          prevConnectionRef.current = data.connection
          setConnection(data.connection)
          // Reload chats/contacts whenever the connection (re)opens. The daemon
          // re-broadcasts after a group sync, so freshly discovered groups and
          // member names show up without a manual `s`.
          if (data.connection === 'open') {
            void loadChats()
            void loadContacts()
            if (openChatRef.current) {
              void openChat(openChatRef.current)
            }
            if (!wasOpen) setStatus('reconnected · synced')
          }
        }
        return
      }
      if (frame.event !== 'message') return

      const record = frame.data as MessageRecord
      const open = openChatRef.current

      setChats((current) => applyIncomingChat(current, record, open))
      if (!record.fromMe && record.chat !== open) {
        const label = contactMapRef.current[record.chat] ?? record.chatName ?? record.chat
        sendNotification(label, previewText(record.text ?? '', 60))
      }
      if (record.chat !== open) return

      setMessages((current) => mergeMessages(current, [record]))
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
  }, [loadChats, loadContacts, openChat])

  useEffect(() => {
    if (status === null) return
    const timer = setTimeout(() => setStatus(null), STATUS_TTL_MS)
    return () => clearTimeout(timer)
  }, [status])

  const layout = useMemo(() => {
    const totalWidth = Math.max(40, columns)
    const listWidth = Math.min(36, Math.max(20, Math.floor(totalWidth * 0.3)))
    const mainHeight = Math.max(6, rows - 4)
    return { listWidth, messageWidth: totalWidth - listWidth, mainHeight }
  }, [columns, rows])

  useInput(
    (input, key) => {
      if (isSearchingContacts) return

      const action = resolveKey(input, key, pane)
      if (!action) return

      switch (action.type) {
        case 'quit':
          exit()
          return
        case 'focus-next':
          setPane((current) => nextPane(current, Boolean(openChatRef.current)))
          return
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
        case 'search-contacts':
          setIsSearchingContacts(true)
          return
        case 'sync-device':
          void (async () => {
            setStatus('syncing with device...')
            try {
              const res = await call<{ ok: boolean; chatCount: number; contactCount: number }>('sync', {})
              await loadChats()
              await loadContacts()
              setStatus(`synced ${res.chatCount} chats, ${res.contactCount} contacts`)
            } catch (err) {
              setStatus(`sync error: ${toErrorPayload(err).message}`)
            }
          })()
          return
        case 'play-media': {
          const curMsgs = messagesRef.current
          if (curMsgs.length === 0) return
          const win = visibleWindow(curMsgs, offset, layout.mainHeight)
          const audioMsg = [...win.items].reverse().find(
            (m) =>
              m.type === 'audioMessage' ||
              Boolean(m.mediaPath && m.mediaPath.match(/\.(ogg|opus|mp3|m4a|wav)$/i)),
          )
          if (audioMsg?.mediaPath) {
            setStatus(`playing audio: ${audioMsg.mediaPath.split('/').pop()}`)
            playAudio(audioMsg.mediaPath).catch((err) => {
              setStatus(`play error: ${(err as Error).message}`)
            })
          } else {
            setStatus('no voice note in view')
          }
          return
        }
        case 'view-media': {
          const curMsgs = messagesRef.current
          if (curMsgs.length === 0) {
            setStatus('no file in view')
            return
          }
          const win = visibleWindow(curMsgs, offset, layout.mainHeight)
          const target = [...win.items]
            .reverse()
            .find((m) => Boolean(m.mediaPath) && !isAudioPath(m.mediaPath as string))
          const mediaPath = target?.mediaPath
          if (!mediaPath) {
            setStatus('no file in view')
            return
          }
          const isImage =
            target.type === 'imageMessage' || /\.(jpe?g|png|webp|gif)$/i.test(mediaPath)
          const label = mediaPath.split('/').pop() ?? mediaPath
          setStatus(`${isImage ? 'viewing image' : 'opening'}: ${label}`)
          const open = isImage ? openImageViewer : openPath
          open(mediaPath).catch((err) => {
            setStatus(`${isImage ? 'viewer' : 'open'} error: ${(err as Error).message}`)
          })
          return
        }
      }
    },
    { isActive: pane !== 'composer' && !isSearchingContacts },
  )

  // Keep selection pointing at the same chat as the list re-sorts.
  useEffect(() => {
    if (openChatJid === null) return
    setSelectedIndex(indexOfChat(chats, openChatJid))
  }, [chats, openChatJid])

  const window = useMemo(
    () => ({ atNewest: offset === 0 }),
    [offset],
  )

  const selectedChat = chats[selectedIndex]
  const title = selectedChat ? contactMap[selectedChat.jid] ?? selectedChat.name ?? selectedChat.jid : null

  return (
    <Box flexDirection="column" width={columns}>
      {isSearchingContacts ? (
        <ContactSearch
          contacts={contacts}
          chats={chats}
          width={columns}
          height={layout.mainHeight}
          onSelect={(jid, name) => {
            setIsSearchingContacts(false)
            if (!chats.some((c) => c.jid === jid)) {
              setChats((cur) =>
                applyIncomingChat(
                  cur,
                  {
                    id: `init-${Date.now()}`,
                    chat: jid,
                    chatName: name ?? null,
                    from: jid,
                    fromName: name ?? null,
                    fromMe: false,
                    ts: Math.floor(Date.now() / 1000),
                    type: 'text',
                    text: '',
                  },
                  jid,
                ),
              )
            }
            void openChat(jid)
            setPane('composer')
          }}
          onClose={() => setIsSearchingContacts(false)}
        />
      ) : (
        <Box flexDirection="row">
          <ChatList
            chats={chats}
            selectedIndex={selectedIndex}
            isFocused={pane === 'list'}
            width={layout.listWidth}
            height={layout.mainHeight}
            contactNames={contactMap}
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
            contactNames={contactMap}
          />
        </Box>
      )}
      <Composer
        isActive={pane === 'composer'}
        width={columns}
        placeholder={
          openChatJid
            ? 'press i to write · @doc/@image/@voice to send media'
            : 'select a chat and press enter to open'
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
