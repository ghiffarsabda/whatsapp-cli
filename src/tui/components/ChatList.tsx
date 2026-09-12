import { Box, Text } from 'ink'
import type { ChatSummary } from '../../shared/protocol.js'
import { displayName, previewText, shortTime } from '../logic.js'

export interface ChatListProps {
  chats: ChatSummary[]
  selectedIndex: number
  isFocused: boolean
  width: number
  height: number
}

export function ChatList({ chats, selectedIndex, isFocused, width, height }: ChatListProps) {
  const rows = Math.max(1, height - 1)
  // Keep the selection inside the visible slice.
  const first = Math.min(Math.max(0, selectedIndex - rows + 1), Math.max(0, chats.length - rows))
  const visible = chats.slice(first, first + rows)

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
    >
      {visible.length === 0 ? (
        <Text dimColor>no chats yet</Text>
      ) : (
        visible.map((chat, index) => {
          const absolute = first + index
          const selected = absolute === selectedIndex
          const name = displayName(chat.jid, chat.name)
          const unread = chat.unread > 0 ? ` (${chat.unread})` : ''
          return (
            <Box key={chat.jid} flexDirection="column">
              <Text
                color={selected ? (isFocused ? 'cyan' : 'white') : undefined}
                inverse={selected && isFocused}
                wrap="truncate-end"
              >
                {selected ? '▸ ' : '  '}
                {name}
                {unread}
              </Text>
              {!selected && width > 24 ? (
                <Text dimColor wrap="truncate-end">
                  {'   '}
                  {shortTime(chat.lastTs)} {previewText(chat.lastText, Math.max(8, width - 14))}
                </Text>
              ) : null}
            </Box>
          )
        })
      )}
    </Box>
  )
}
