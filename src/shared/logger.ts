import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import pino from 'pino'
import { paths } from './paths.js'

export type Logger = pino.Logger

let cached: Logger | undefined

/**
 * Logger that writes to daemon.log (or nowhere when silent).
 * It must never write to stdout: the daemon's stdout is inherited by whoever
 * spawned it, and stray output would corrupt a client's JSON stream.
 */
export function getLogger(options: { verbose?: boolean } = {}): Logger {
  if (cached) return cached

  const level = process.env.WHATSAPP_CLI_LOG_LEVEL ?? (options.verbose ? 'debug' : 'info')
  const target = paths().logFile
  mkdirSync(dirname(target), { recursive: true })

  cached = pino(
    { level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    createWriteStream(target, { flags: 'a' }),
  )
  return cached
}

/** A logger that discards everything, for tests and short-lived CLI processes. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' })
}
