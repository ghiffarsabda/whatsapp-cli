import { openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureParentDir } from '../shared/atomic.js'
import { daemonUnreachable } from '../shared/errors.js'
import { paths } from '../shared/paths.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { call, probe } from './ipc-client.js'

const START_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 100

export interface EnsureDaemonOptions {
  dataDir?: string
  timeoutMs?: number
  /** Set false for commands that must never start a daemon (stop, logout, schema). */
  spawn?: boolean
}

function daemonEntry(): { command: string; args: string[] } {
  const moduleUrl = import.meta.url
  const isTypeScript = moduleUrl.endsWith('.ts')
  const entry = fileURLToPath(
    new URL(isTypeScript ? '../daemon/main.ts' : '../daemon/main.js', moduleUrl),
  )
  // Under tsx (dev) the daemon must be started through the loader too.
  return isTypeScript
    ? { command: process.execPath, args: ['--import', 'tsx', entry] }
    : { command: process.execPath, args: [entry] }
}

function spawnDetached(dataDir: string | undefined): void {
  const target = paths()
  ensureParentDir(target.logFile)
  const logFd = openSync(target.logFile, 'a')

  const { command, args } = daemonEntry()
  const daemonArgs = dataDir ? [...args, '--data-dir', dataDir] : args

  const child = spawn(command, daemonArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  child.unref()
}

/**
 * The protocol version a running daemon reports, or null when it cannot be
 * reached or does not answer with one. A daemon built before this field existed
 * returns its state version, which never matches PROTOCOL_VERSION.
 */
async function runningVersion(socketPath: string): Promise<number | null> {
  try {
    const status = await call<{ version?: number }>('status', {}, { timeoutMs: 2_000, socketPath })
    return typeof status.version === 'number' ? status.version : null
  } catch {
    return null
  }
}

/** Wait for a stale daemon to release its socket before we start a new one. */
async function waitForSocketToClose(socketPath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probe(socketPath, 300))) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Ensure a daemon is reachable, starting one if needed.
 * This is what makes every command work with no setup step.
 */
export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<void> {
  const socketPath = paths().socketPath
  if (await probe(socketPath)) {
    if ((await runningVersion(socketPath)) === PROTOCOL_VERSION) return

    if (options.spawn === false) {
      throw daemonUnreachable(`No daemon is running at ${socketPath}`)
    }

    // A daemon from an older build can lack newer methods (e.g. `sync`). Stop it
    // and let the spawn below replace it with a current one.
    try {
      await call('shutdown', {}, { timeoutMs: 2_000, socketPath })
    } catch {
      // Best effort: if it refuses to stop, the spawn may still take over.
    }
    await waitForSocketToClose(socketPath)
  }

  if (options.spawn === false) {
    throw daemonUnreachable(`No daemon is running at ${socketPath}`)
  }

  spawnDetached(options.dataDir)

  const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    if (await probe(socketPath, 300)) {
      // The socket answers now, but give the request path one real round trip.
      try {
        await call('status', {}, { timeoutMs: 5_000 })
        return
      } catch {
        // Not fully ready yet; keep polling until the deadline.
      }
    }
  }

  throw daemonUnreachable(
    'The daemon did not become ready in time',
    `Check the log at ${paths().logFile}`,
  )
}
