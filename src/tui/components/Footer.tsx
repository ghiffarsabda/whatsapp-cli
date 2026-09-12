import { Box, Text } from 'ink'
import { hintsFor, type Pane } from '../keys.js'

export interface FooterProps {
  pane: Pane
  atNewest: boolean
  connection: string
  unread: number
  message: string | null
  width: number
}

function connectionColor(connection: string): string {
  if (connection === 'open') return 'green'
  if (connection === 'close') return 'red'
  return 'yellow'
}

export function Footer({ pane, atNewest, connection, unread, message, width }: FooterProps) {
  return (
    <Box flexDirection="row" width={width} justifyContent="space-between">
      <Text dimColor wrap="truncate-end">
        {hintsFor(pane, atNewest)}
      </Text>
      <Text wrap="truncate-end">
        {message ? <Text color="yellow">{message} </Text> : null}
        {unread > 0 ? <Text color="yellow">{unread} unread </Text> : null}
        <Text color={connectionColor(connection)}>{connection}</Text>
      </Text>
    </Box>
  )
}
