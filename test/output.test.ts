import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { AppError, EXIT_CODES, exitCodeFor, toErrorPayload } from '../src/shared/errors.js'
import { emitError, emitOk, resolveOutputOptions } from '../src/cli/output.js'

interface Captured {
  stdout: string[]
  stderr: string[]
}

function capture(): Captured {
  const captured: Captured = { stdout: [], stderr: [] }
  process.stdout.write = ((chunk: string) => {
    captured.stdout.push(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    captured.stderr.push(chunk)
    return true
  }) as typeof process.stderr.write
  return captured
}

const originalStdout = process.stdout.write.bind(process.stdout)
const originalStderr = process.stderr.write.bind(process.stderr)

afterEach(() => {
  process.stdout.write = originalStdout
  process.stderr.write = originalStderr
  delete process.env.WHATSAPP_CLI_JSON
  delete process.env.NO_COLOR
})

function setTty(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
}

test('json is selected automatically when stdout is not a TTY', () => {
  setTty(false)
  assert.equal(resolveOutputOptions({}).format, 'json')
})

test('text is selected on a TTY, and json can be forced', () => {
  setTty(true)
  assert.equal(resolveOutputOptions({}).format, 'text')
  assert.equal(resolveOutputOptions({ json: true }).format, 'json')
  assert.equal(resolveOutputOptions({ format: 'json' }).format, 'json')
  assert.equal(resolveOutputOptions({ format: 'text' }).format, 'text')
})

test('WHATSAPP_CLI_JSON forces json output', () => {
  setTty(true)
  process.env.WHATSAPP_CLI_JSON = '1'
  assert.equal(resolveOutputOptions({}).format, 'json')

  process.env.WHATSAPP_CLI_JSON = '0'
  assert.equal(resolveOutputOptions({}).format, 'text')
})

test('color is disabled without a TTY and by NO_COLOR', () => {
  setTty(false)
  assert.equal(resolveOutputOptions({}).color, false)

  setTty(true)
  assert.equal(resolveOutputOptions({}).color, true)

  process.env.NO_COLOR = '1'
  assert.equal(resolveOutputOptions({}).color, false)

  delete process.env.NO_COLOR
  assert.equal(resolveOutputOptions({ color: false }).color, false)
})

test('emitOk writes a single JSON object in json mode', () => {
  const captured = capture()
  const options = { format: 'json' as const, color: false, quiet: false }
  emitOk({ a: 1 }, options, () => 'ignored')

  assert.equal(captured.stdout.length, 1)
  assert.deepEqual(JSON.parse(captured.stdout[0]!), { ok: true, data: { a: 1 } })
  assert.equal(captured.stderr.length, 0)
})

test('emitOk uses the renderer in text mode and respects quiet', () => {
  const captured = capture()
  const options = { format: 'text' as const, color: false, quiet: false }
  emitOk({ a: 1 }, options, () => 'rendered')
  assert.equal(captured.stdout.join(''), 'rendered\n')

  const quiet = capture()
  emitOk({ a: 1 }, { ...options, quiet: true }, () => 'rendered')
  assert.equal(quiet.stdout.join(''), '')
})

test('emitError puts JSON on stdout and text on stderr, never both', () => {
  const json = capture()
  const code = emitError(new AppError('not_found', 'nope', { hint: 'try again' }), {
    format: 'json',
    color: false,
    quiet: false,
  })
  assert.equal(code, EXIT_CODES.not_found)
  assert.deepEqual(JSON.parse(json.stdout[0]!), {
    ok: false,
    error: { code: 'not_found', message: 'nope', hint: 'try again' },
  })
  assert.equal(json.stderr.length, 0)

  const text = capture()
  const textCode = emitError(new AppError('usage', 'bad flag'), {
    format: 'text',
    color: false,
    quiet: false,
  })
  assert.equal(textCode, EXIT_CODES.usage)
  assert.equal(text.stdout.length, 0)
  assert.match(text.stderr.join(''), /bad flag/)
})

test('error payloads carry machine-readable details', () => {
  const captured = capture()
  const error = new AppError('ambiguous', 'matches 2 chats', {
    hint: 'Re-run with a full JID',
    details: { candidates: ['a@g.us', 'b@g.us'] },
  })

  emitError(error, { format: 'json', color: false, quiet: false })
  const payload = JSON.parse(captured.stdout[0]!).error
  assert.deepEqual(payload.details, { candidates: ['a@g.us', 'b@g.us'] })

  const text = capture()
  emitError(error, { format: 'text', color: false, quiet: false })
  assert.match(text.stderr.join(''), /a@g\.us, b@g\.us/)
})

test('error payloads and exit codes map correctly', () => {
  assert.equal(exitCodeFor(new AppError('not_logged_in', 'x')), 3)
  assert.equal(exitCodeFor(new AppError('daemon_unreachable', 'x')), 4)
  assert.equal(exitCodeFor(new AppError('ambiguous', 'x')), 5)
  assert.equal(exitCodeFor(new AppError('send_failed', 'x')), 6)
  assert.equal(exitCodeFor(new AppError('timeout', 'x')), 7)
  assert.equal(exitCodeFor(new AppError('internal', 'x')), 1)

  // Unknown errors must not leak internals but stay usable.
  assert.deepEqual(toErrorPayload(new Error('boom')), { code: 'internal', message: 'boom' })
  assert.equal(exitCodeFor(new Error('boom')), 1)
})

test('AppError omits an undefined hint', () => {
  assert.deepEqual(new AppError('usage', 'msg').toPayload(), { code: 'usage', message: 'msg' })
})
