import { Box, Text } from 'ink'
import type { MessageRecord } from '../../shared/protocol.js'
import { displayName, fitMessages, shortTime, visibleWindow } from '../logic.js'

export interface MessagePaneProps {
  messages: MessageRecord[]
  chatName: string | null
  chatJid: string | null
  offset: number
  isFocused: boolean
  width: number
  height: number
  meName: string | null
  contactNames?: Record<string, string>
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
  contactNames,
}: MessagePaneProps) {
  const fullChatName = chatJid
    ? contactNames?.[chatJid] ?? displayName(chatJid, chatName)
    : 'no chat selected'
  const window = visibleWindow(messages, offset, height)
  // Keep only messages that fit the visible rows so a long message cannot push
  // the pane into a broken, overflowing layout.
  const fitted = fitMessages(window.items, Math.max(1, height - 3), width)

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor={isFocused ? 'cyan' : 'gray'}
    >
      <Box
        flexDirection="column"
        height={Math.max(1, height - 2)}
        justifyContent="flex-end"
        overflow="hidden"
      >
        {window.items.length === 0 ? (
          <Text dimColor>{chatJid ? 'no messages' : fullChatName}</Text>
        ) : (
          fitted.map((message) => {
            const who = message.fromMe
              ? meName ?? 'me'
              : contactNames?.[message.from] ?? displayName(message.from, message.fromName)

            const isImage =
              message.type === 'imageMessage' ||
              Boolean(message.mediaPath && message.mediaPath.match(/\.(jpe?g|png|webp|gif)$/i))
            const isAudio =
              message.type === 'audioMessage' ||
              Boolean(message.mediaPath && message.mediaPath.match(/\.(ogg|opus|mp3|m4a|wav)$/i))
            const isDoc =
              message.type === 'documentMessage' ||
              Boolean(message.mediaPath && !isImage && !isAudio)

            const fileUri = message.mediaPath
              ? message.mediaPath.startsWith('file://')
                ? message.mediaPath
                : `file://${message.mediaPath}`
              : null

            return (
              <Box key={`${message.chat}\u0000${message.id}`} flexDirection="column" marginY={0}>
                <Text wrap="wrap">
                  <Text dimColor>{shortTime(message.ts)} </Text>
                  <Text color={message.fromMe ? 'green' : 'cyan'} bold>
                    {who}
                  </Text>
                  <Text dimColor>:</Text>
                </Text>

                <Text wrap="wrap">{message.text}</Text>

                {fileUri && isImage ? (
                  <Text dimColor wrap="wrap">
                    {'  '}📷 Ctrl+Click to view:{' '}
                    <Text underline color="cyan">
                      {fileUri}
                    </Text>{' '}
                    (press 'v')
                  </Text>
                ) : null}

                {fileUri && isAudio ? (
                  <Text dimColor wrap="wrap">
                    {'  '}🎤 Ctrl+Click to open:{' '}
                    <Text underline color="cyan">
                      {fileUri}
                    </Text>{' '}
                    (press 'p' to play)
                  </Text>
                ) : null}

                {fileUri && isDoc ? (
                  <Text dimColor wrap="wrap">
                    {'  '}📄 Ctrl+Click to open:{' '}
                    <Text underline color="cyan">
                      {fileUri}
                    </Text>
                    {message.fileName ? ` ${message.fileName}` : ''} (press 'v')
                  </Text>
                ) : null}
              </Box>
            )
          })
        )}
      </Box>
      <Text dimColor wrap="truncate-end">
        {fullChatName}
        {chatJid && !chatJid.includes('@g.us') ? ` (+${chatJid.split('@')[0]})` : ''}
        {window.hiddenOlder > 0 ? ` · ${window.hiddenOlder} older not shown` : ''}
        {!window.atNewest ? ' · scrolled back' : ''}
      </Text>
    </Box>
  )
}
