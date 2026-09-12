import { exitCodeFor, toErrorPayload } from '../shared/errors.js'

export type OutputFormat = 'json' | 'text'

export interface OutputOptions {
  format: OutputFormat
  color: boolean
  quiet: boolean
}

export interface OutputFlags {
  json?: boolean
  format?: string
  color?: boolean
  quiet?: boolean
}

/**
 * Output contract for both humans and agents.
 *
 * JSON is selected explicitly via `--json`/`--format=json`, or implicitly when
 * stdout is not a TTY so that piping into an agent or `jq` just works.
 */
export function resolveOutputOptions(flags: OutputFlags): OutputOptions {
  const envJson = process.env.WHATSAPP_CLI_JSON
  const envWantsJson = envJson !== undefined && envJson !== '' && envJson !== '0' && envJson !== 'false'

  let format: OutputFormat
  if (flags.format === 'json' || flags.format === 'text') {
    format = flags.format
  } else if (flags.json || envWantsJson) {
    format = 'json'
  } else {
    format = process.stdout.isTTY ? 'text' : 'json'
  }

  const color =
    flags.color !== false && process.env.NO_COLOR === undefined && process.stdout.isTTY === true

  return { format, color, quiet: flags.quiet === true }
}

const CODES = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
} as const

export function paint(text: string, style: keyof typeof CODES, options: OutputOptions): string {
  if (!options.color) return text
  return `${CODES[style]}${text}${CODES.reset}`
}

/** Success output. `render` produces the human-readable form for text mode. */
export function emitOk<T>(data: T, options: OutputOptions, render: (data: T) => string): void {
  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`)
    return
  }
  if (options.quiet) return
  const text = render(data)
  if (text !== '') process.stdout.write(`${text}\n`)
}

/**
 * Failure output. In text mode the message goes to stderr so stdout stays
 * clean and parseable. Returns the process exit code.
 */
export function emitError(error: unknown, options: OutputOptions): number {
  const payload = toErrorPayload(error)

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify({ ok: false, error: payload })}\n`)
  } else {
    const label = paint(`error [${payload.code}]`, 'red', options)
    process.stderr.write(`${label} ${payload.message}\n`)
    if (payload.hint) process.stderr.write(`${paint('hint', 'dim', options)} ${payload.hint}\n`)

    const candidates = (payload.details as { candidates?: unknown } | undefined)?.candidates
    if (Array.isArray(candidates) && candidates.length > 0) {
      process.stderr.write(`${paint('candidates', 'dim', options)} ${candidates.join(', ')}\n`)
    }
  }

  return exitCodeFor(error)
}

/** Emit a single NDJSON frame, used by streaming commands like `watch`. */
export function emitFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}
