/** Which pane owns the keystroke. */
export type Pane = 'list' | 'messages' | 'composer'

export interface KeyLike {
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  escape?: boolean
  tab?: boolean
  ctrl?: boolean
  shift?: boolean
  pageUp?: boolean
  pageDown?: boolean
  backspace?: boolean
  delete?: boolean
}

export type Action =
  | { type: 'quit' }
  | { type: 'focus-next' }
  | { type: 'focus-list' }
  | { type: 'focus-composer' }
  | { type: 'select-delta'; delta: number }
  | { type: 'select-first' }
  | { type: 'select-last' }
  | { type: 'open-chat' }
  | { type: 'scroll-delta'; delta: number }
  | { type: 'scroll-newest' }
  | { type: 'load-older' }
  | { type: 'search-contacts' }
  | { type: 'sync-device' }
  | { type: 'play-media' }
  | { type: 'view-media' }

const NONE = null

/**
 * Translate a keystroke into an action for the focused pane.
 *
 * Text entry in the composer is deliberately not handled here: the composer owns
 * its own buffer, and this only recognises the keys that leave it.
 */
export function resolveKey(input: string, key: KeyLike, pane: Pane): Action | null {
  // Always available, in any pane.
  if (key.ctrl && input === 'c') return { type: 'quit' }
  if (key.tab) return { type: 'focus-next' }

  if (pane === 'composer') {
    // Everything except escape belongs to the text buffer, including 'q'.
    return key.escape ? { type: 'focus-list' } : NONE
  }

  if (input === 'q') return { type: 'quit' }

  if (pane === 'list') {
    if (key.downArrow || input === 'j') return { type: 'select-delta', delta: 1 }
    if (key.upArrow || input === 'k') return { type: 'select-delta', delta: -1 }
    if (input === 'g') return { type: 'select-first' }
    if (input === 'G') return { type: 'select-last' }
    if (key.return || input === 'l') return { type: 'open-chat' }
    if (input === '/' || input === 'n') return { type: 'search-contacts' }
    if (input === 'i') return { type: 'focus-composer' }
    if (input === 's') return { type: 'sync-device' }
    return NONE
  }

  // Message pane.
  if (key.downArrow || input === 'j') return { type: 'scroll-delta', delta: -1 }
  if (key.upArrow || input === 'k') return { type: 'scroll-delta', delta: 1 }
  if (key.pageDown) return { type: 'scroll-delta', delta: -10 }
  if (key.pageUp) return { type: 'scroll-delta', delta: 10 }
  if (input === 'G') return { type: 'scroll-newest' }
  if (input === 'o') return { type: 'load-older' }
  if (input === 'p') return { type: 'play-media' }
  if (input === 'v') return { type: 'view-media' }
  // Writing is entered only with `i`; esc leaves it again.
  if (input === 'i') return { type: 'focus-composer' }
  return NONE
}

/** Keys shown in the footer for the focused pane. */
export function hintsFor(pane: Pane, atNewest: boolean): string {
  if (pane === 'composer') return 'enter send · esc back · ctrl+c quit'
  if (pane === 'messages') {
    return atNewest
      ? 'j/k scroll · i write · tab chats · p play · v open · q quit'
      : 'j/k scroll · G newest · i write · p play · v open · q quit'
  }
  return 'j/k move · enter open · tab chat · / search · s sync · q quit'
}
