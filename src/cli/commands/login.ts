import qrcode from 'qrcode-terminal'
import { notLoggedIn, timedOut } from '../../shared/errors.js'
import type { LoginResult } from '../../shared/protocol.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call } from '../ipc-client.js'
import { emitOk, paint, type OutputOptions } from '../output.js'
import { renderState } from '../render.js'
import type { CommandContext } from './context.js'
import type { StatusResult } from './status.js'

export interface LoginFlags {
  phone?: string
  wait?: boolean
  timeout?: number
}

function renderQr(value: string): void {
  qrcode.generate(value, { small: true }, (output) => {
    process.stdout.write(`${output}\n`)
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Pair this device.
 *
 * Text mode renders the QR and waits for the link to complete. JSON mode
 * returns immediately with the raw QR payload and pairing code, because an
 * agent cannot scan a terminal QR — it should poll `status` instead.
 */
export async function loginCommand(
  flags: LoginFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  await ensureDaemon({ dataDir: context.dataDir })

  if (flags.phone) {
    const result = await call<LoginResult>('ensureLogin', { phone: flags.phone })
    if (result.pairingCode && options.format === 'text') {
      process.stdout.write(
        `\nPairing code: ${paint(result.pairingCode, 'bold', options)}\n` +
          'Enter it on your phone under WhatsApp > Linked devices > Link with phone number.\n\n',
      )
    }
  }

  const shouldWait = flags.wait === true || options.format === 'text'
  if (!shouldWait) {
    const state = await call<StatusResult>('status')
    emitOk(state, options, renderState)
    return
  }

  const deadline = flags.timeout && flags.timeout > 0 ? Date.now() + flags.timeout : Infinity
  let lastQr: string | null = null

  for (;;) {
    const state = await call<StatusResult>('status', {}, { timeoutMs: 5_000 })

    if (state.connection === 'open' && state.loggedIn) {
      if (options.format === 'json') {
        emitOk(state, options, renderState)
      } else {
        const who = state.me?.name ?? state.me?.jid ?? 'this device'
        process.stdout.write(`\n${paint('Linked', 'green', options)} as ${who}.\n`)
        process.stdout.write('Login is stored on disk — future commands will not need a QR code.\n')
      }
      return
    }

    if (state.connection === 'logged_out') throw notLoggedIn()

    if (state.qr && state.qr.value !== lastQr) {
      lastQr = state.qr.value
      if (options.format === 'text') {
        process.stdout.write('\nScan this QR code with WhatsApp > Linked devices:\n\n')
        renderQr(state.qr.value)
        process.stdout.write(`\n${paint('waiting for scan...', 'dim', options)}\n`)
      }
    }

    if (Date.now() > deadline) {
      throw timedOut('Timed out waiting for the QR code to be scanned')
    }
    await sleep(1_000)
  }
}
