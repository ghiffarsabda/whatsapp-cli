import { Box, Text, useInput, usePaste } from 'ink'
import { useCallback, useRef, useState } from 'react'

export interface ComposerProps {
  isActive: boolean
  width: number
  placeholder?: string
  onSubmit: (text: string) => void
  onExit: () => void
}

const MAX_HISTORY = 50

interface EditorState {
  chars: string[]
  cursor: number
  history: string[]
  historyIndex: number
}

const EMPTY: EditorState = { chars: [], cursor: 0, history: [], historyIndex: -1 }

/**
 * Single-line composer.
 *
 * Editor state lives in a ref rather than React state because keystrokes can
 * arrive faster than renders: with state-in-closure, a burst of input all reads
 * the same stale cursor and characters end up inserted in the wrong place. A
 * ref makes each edit atomic, and a re-render is forced afterwards.
 *
 * All edits work on code points (via `Array.from`) so emoji and CJK characters
 * are never split by the cursor.
 */
export function Composer({ isActive, width, placeholder, onSubmit, onExit }: ComposerProps) {
  const editorRef = useRef<EditorState>(EMPTY)
  const [, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => (n + 1) % 1_000_000), [])

  const edit = useCallback(
    (mutate: (state: EditorState) => EditorState) => {
      editorRef.current = mutate(editorRef.current)
      rerender()
    },
    [rerender],
  )

  const insert = useCallback(
    (text: string) => {
      const inserted = Array.from(text)
      if (inserted.length === 0) return
      edit((state) => {
        const chars = [...state.chars]
        chars.splice(state.cursor, 0, ...inserted)
        return { ...state, chars, cursor: state.cursor + inserted.length, historyIndex: -1 }
      })
    },
    [edit],
  )

  useInput(
    (input, key) => {
      if (key.escape) {
        onExit()
        return
      }

      if (key.return) {
        const body = editorRef.current.chars.join('').trim()
        if (body === '') return
        edit((state) => ({
          ...EMPTY,
          history: [...state.history, body].slice(-MAX_HISTORY),
        }))
        onSubmit(body)
        return
      }

      if (key.leftArrow) return edit((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) }))
      if (key.rightArrow) {
        return edit((s) => ({ ...s, cursor: Math.min(s.chars.length, s.cursor + 1) }))
      }
      if (key.ctrl && input === 'a') return edit((s) => ({ ...s, cursor: 0 }))
      if (key.ctrl && input === 'e') {
        return edit((s) => ({ ...s, cursor: s.chars.length }))
      }
      if (key.ctrl && input === 'u') return edit(() => EMPTY)

      if (key.upArrow) {
        return edit((state) => {
          if (state.history.length === 0) return state
          const next =
            state.historyIndex === -1
              ? state.history.length - 1
              : Math.max(0, state.historyIndex - 1)
          const chars = Array.from(state.history[next] ?? '')
          return { ...state, chars, cursor: chars.length, historyIndex: next }
        })
      }
      if (key.downArrow) {
        return edit((state) => {
          if (state.historyIndex === -1) return state
          const next = state.historyIndex + 1
          if (next >= state.history.length) {
            return { ...EMPTY, history: state.history }
          }
          const chars = Array.from(state.history[next] ?? '')
          return { ...state, chars, cursor: chars.length, historyIndex: next }
        })
      }

      if (key.backspace || key.delete) {
        edit((state) => {
          if (state.cursor === 0) return state
          const chars = [...state.chars]
          chars.splice(state.cursor - 1, 1)
          return { ...state, chars, cursor: state.cursor - 1, historyIndex: -1 }
        })
        return
      }

      // Let control chords and non-printable keys through untouched.
      if (key.ctrl || key.tab || input === '') return
      insert(input)
    },
    { isActive },
  )

  // Bracketed paste arrives as one string; keep it on a single line.
  usePaste((pasted) => insert(pasted.replace(/\r?\n/g, ' ')), { isActive })

  const { chars, cursor } = editorRef.current

  // Keep the caret in view when the line is longer than the box.
  const inner = Math.max(4, width - 4)
  let view = chars
  let viewCursor = cursor
  if (chars.length > inner) {
    const shift = Math.min(Math.max(0, cursor - inner + 1), chars.length - inner)
    view = chars.slice(shift, shift + inner)
    viewCursor = cursor - shift
  }

  const before = view.slice(0, viewCursor).join('')
  const current = view[viewCursor] ?? ' '
  const after = view.slice(viewCursor + 1).join('')

  const showPlaceholder = chars.length === 0 && !isActive

  return (
    <Box width={width} height={3} borderStyle="round" borderColor={isActive ? 'cyan' : 'gray'}>
      {showPlaceholder ? (
        <Text dimColor>{placeholder ?? 'select a chat and press i to write'}</Text>
      ) : (
        <Text wrap="truncate-end">
          <Text dimColor>{'> '}</Text>
          {before}
          <Text inverse>{current}</Text>
          {after}
        </Text>
      )}
    </Box>
  )
}
