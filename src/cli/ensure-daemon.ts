import { openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureParentDir } from '../shared/atomic.js'
import { daemonUnreachable } from '../shared/errors.js'
import { paths } from '../shared/paths.js'
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
 * Ensure a daemon is reachable, starting one if needed.
 * This is what makes every command work with no setup step.
 */
export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<void> {
  const socketPath = paths().socketPath
  if (await probe(socketPath)) return

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
