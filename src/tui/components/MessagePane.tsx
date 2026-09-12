import { Box, Text } from 'ink'
import type { MessageRecord } from '../../shared/protocol.js'
import { displayName, shortTime, visibleWindow } from '../logic.js'

export interface MessagePaneProps {
  messages: MessageRecord[]
  chatName: string | null
  chatJid: string | null
  offset: number
  isFocused: boolean
  width: number
  height: number
  meName: string | null
}

export function MessagePane({
  messages,
  chatName,
  chatJid,
  offset,
  isFocused,
  width,
  height,
  meName,
}: MessagePaneProps) {
  const title = chatJid ? displayName(chatJid, chatName) : 'no chat selected'
  const window = visibleWindow(messages, offset, height)

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
    >
      <Box flexDirection="column" height={Math.max(1, height - 2)} justifyContent="flex-end" overflow="hidden">
        {window.items.length === 0 ? (
          <Text dimColor>{chatJid ? 'no messages' : title}</Text>
        ) : (
          window.items.map((message) => {
            const who = message.fromMe
              ? meName ?? 'me'
              : displayName(message.from, message.fromName)
            return (
              <Box key={`${message.chat}\u0000${message.id}`} flexDirection="column">
                <Text wrap="wrap">
                  <Text dimColor>{shortTime(message.ts)} </Text>
                  <Text color={message.fromMe ? 'green' : 'cyan'} bold>
                    {who}
                  </Text>
                  <Text dimColor>:</Text>
                </Text>
                <Text wrap="wrap">{message.text}</Text>
              </Box>
            )
          })
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {title}
        {window.hiddenOlder > 0 ? ` · ${window.hiddenOlder} older not shown` : ''}
        {!window.atNewest ? ' · scrolled back' : ''}
      </Text>
    </Box>
  )
}
