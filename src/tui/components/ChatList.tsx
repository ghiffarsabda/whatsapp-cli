import { Box, Text } from 'ink'
import type { ChatSummary } from '../../shared/protocol.js'
import { displayName, previewText, shortTime } from '../logic.js'

export interface ChatListProps {
  chats: ChatSummary[]
  selectedIndex: number
  isFocused: boolean
  width: number
  height: number
  contactNames?: Record<string, string>
}

export function ChatList({
  chats,
  selectedIndex,
  isFocused,
  width,
  height,
  contactNames,
}: ChatListProps) {
  // Height available inside outer container
  const innerHeight = Math.max(1, height - 2)
  const cardHeight = height >= 14 ? 3 : 2
  const maxVisibleCards = Math.max(1, Math.floor(innerHeight / cardHeight))

  // Keep selection within visible slice
  const first = Math.min(
    Math.max(0, selectedIndex - maxVisibleCards + 1),
    Math.max(0, chats.length - maxVisibleCards),
  )
  const visible = chats.slice(first, first + maxVisibleCards)

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
      overflow="hidden"
    >
      {visible.length === 0 ? (
        <Text dimColor>no chats yet</Text>
      ) : (
        visible.map((chat, index) => {
          const absolute = first + index
          const selected = absolute === selectedIndex
          const name = contactNames?.[chat.jid] ?? displayName(chat.jid, chat.name)
          const unread = chat.unread > 0 ? ` (${chat.unread})` : ''

          return (
            <Box
              key={chat.jid}
              flexDirection="column"
              width={Math.max(10, width - 2)}
              borderStyle={selected ? 'round' : 'single'}
              borderColor={selected ? (isFocused ? 'cyan' : 'white') : 'gray'}
              paddingX={1}
            >
              <Box flexDirection="row" justifyContent="space-between">
                <Text
                  color={selected ? (isFocused ? 'cyan' : 'white') : undefined}
                  bold={selected}
                  wrap="truncate-end"
                >
                  {selected ? '▸ ' : '  '}
                  {chat.isGroup ? <Text color="cyan">[GRP] </Text> : null}
                  {name}
                  {unread}
                </Text>
                {chat.lastTs > 0 && width >= 40 ? (
                  <Text dimColor wrap="truncate-end">
                    {shortTime(chat.lastTs)}
                  </Text>
                ) : null}
              </Box>

              {cardHeight === 3 && width > 22 ? (
                <Box flexDirection="row" justifyContent="space-between">
                  <Text dimColor wrap="truncate-end">
                    {previewText(chat.lastText, Math.max(8, width - 18))}
                  </Text>
                  {chat.lastTs > 0 && width < 40 ? (
                    <Text dimColor wrap="truncate-end">
                      {shortTime(chat.lastTs)}
                    </Text>
                  ) : null}
                </Box>
              ) : null}
            </Box>
          )
        })
      )}
    </Box>
  )
}
