import { Box, Text, useInput } from 'ink'
import { useMemo, useState } from 'react'
import type { ChatSummary, ContactSummary } from '../../shared/protocol.js'
import { moveSelection } from '../logic.js'

export interface ContactSearchItem {
  jid: string
  name: string
  subtitle: string
  isGroup: boolean
}

export interface ContactSearchProps {
  contacts: ContactSummary[]
  chats: ChatSummary[]
  width: number
  height: number
  onSelect: (jid: string, name?: string | null) => void
  onClose: () => void
}

export function ContactSearch({
  contacts,
  chats,
  width,
  height,
  onSelect,
  onClose,
}: ContactSearchProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Merge unique entries across contacts and chats
  const items = useMemo(() => {
    const map = new Map<string, ContactSearchItem>()

    for (const c of contacts) {
      const name = c.name ?? c.notify ?? c.phone ?? c.jid.split('@')[0] ?? c.jid
      const subtitle = c.phone ? `+${c.phone}` : c.jid
      map.set(c.jid, {
        jid: c.jid,
        name,
        subtitle,
        isGroup: c.isGroup,
      })
    }

    for (const chat of chats) {
      if (!map.has(chat.jid)) {
        const name = chat.name ?? chat.jid.split('@')[0] ?? chat.jid
        map.set(chat.jid, {
          jid: chat.jid,
          name,
          subtitle: chat.jid,
          isGroup: chat.isGroup,
        })
      }
    }

    let list = [...map.values()]
    const q = query.trim().toLowerCase()
    if (q !== '') {
      list = list.filter(
        (item) =>
          item.name.toLowerCase().includes(q) ||
          item.subtitle.toLowerCase().includes(q) ||
          item.jid.toLowerCase().includes(q),
      )
      // If query is a phone number with no exact match, allow synthesizing
      const digits = q.replace(/[^\d]/g, '')
      if (digits.length >= 7 && !list.some((i) => i.jid.startsWith(digits))) {
        list.unshift({
          jid: `${digits}@s.whatsapp.net`,
          name: `+${digits}`,
          subtitle: 'New contact number',
          isGroup: false,
        })
      }
    }

    return list
  }, [contacts, chats, query])

  useInput((input, key) => {
    if (key.escape) {
      onClose()
      return
    }

    if (key.return) {
      const selected = items[selectedIndex]
      if (selected) {
        onSelect(selected.jid, selected.name)
      } else if (query.trim() !== '') {
        const digits = query.replace(/[^\d]/g, '')
        if (digits.length >= 7) {
          onSelect(`${digits}@s.whatsapp.net`, `+${digits}`)
        }
      }
      return
    }

    if (key.downArrow || (key.ctrl && input === 'n')) {
      setSelectedIndex((cur) => moveSelection(cur, 1, items.length))
      return
    }

    if (key.upArrow || (key.ctrl && input === 'p')) {
      setSelectedIndex((cur) => moveSelection(cur, -1, items.length))
      return
    }

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
      setSelectedIndex(0)
      return
    }

    if (!key.ctrl && input.length > 0) {
      setQuery((q) => q + input)
      setSelectedIndex(0)
    }
  })

  const rows = Math.max(3, height - 5)
  const first = Math.min(Math.max(0, selectedIndex - rows + 1), Math.max(0, items.length - rows))
  const visible = items.slice(first, first + rows)

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="cyan">
          🔍 Search Contacts / Start Chat
        </Text>
        <Text dimColor>esc to cancel · enter to open</Text>
      </Box>

      <Box marginY={1}>
        <Text bold color="white">
          {'> '}
        </Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
      </Box>

      <Box flexDirection="column" height={rows} overflow="hidden">
        {visible.length === 0 ? (
          <Text dimColor>
            {query.trim() ? `No contacts matching "${query}"` : 'Type a name or phone number...'}
          </Text>
        ) : (
          visible.map((item, idx) => {
            const absolute = first + idx
            const isSelected = absolute === selectedIndex
            const tag = item.isGroup ? '[GRP]' : '[DIR]'

            return (
              <Box key={item.jid} flexDirection="row" justifyContent="space-between">
                <Text
                  color={isSelected ? 'cyan' : undefined}
                  inverse={isSelected}
                  wrap="truncate-end"
                >
                  {isSelected ? '▸ ' : '  '}
                  <Text bold>{item.name}</Text>
                  {item.subtitle !== item.name ? ` (${item.subtitle})` : ''}
                </Text>
                <Text dimColor>{tag}</Text>
              </Box>
            )
          })
        )}
      </Box>
    </Box>
  )
}
