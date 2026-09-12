import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic, ensureParentDir } from './atomic.js'
import type { DaemonState } from './protocol.js'
import { paths } from './paths.js'

export const STATE_VERSION = 1

export function defaultState(pid: number): DaemonState {
  return {
    version: STATE_VERSION,
    pid,
    startedAt: new Date().toISOString(),
    connection: 'connecting',
    loggedIn: false,
    me: null,
    qr: null,
    pairingCode: null,
    reconnect: { attempts: 0, nextAt: null },
    lastDisconnect: null,
  }
}

/** Read state.json, tolerating absence and partial/corrupt content. */
export function readState(): DaemonState | null {
  const file = paths().stateFile
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DaemonState
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed
  } catch {
    return null
  }
}

export function writeState(state: DaemonState): void {
  const file = paths().stateFile
  ensureParentDir(file)
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
}
