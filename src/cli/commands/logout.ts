import { rmSync } from 'node:fs'
import { usage } from '../../shared/errors.js'
import { paths } from '../../shared/paths.js'
import { call, probe } from '../ipc-client.js'
import { emitOk, type OutputOptions } from '../output.js'

export interface LogoutFlags {
  yes?: boolean
}

export async function logoutCommand(
  flags: LogoutFlags,
  options: OutputOptions,
): Promise<void> {
  if (flags.yes !== true) {
    throw usage('Refusing to log out without --yes', 'This unlinks the device and deletes local credentials.')
  }

  const target = paths()
  let viaDaemon = false

  // No daemon: still clear credentials so the next run starts clean.
  if (await probe(target.socketPath)) {
    await call('logout', {}, { timeoutMs: 15_000 })
    viaDaemon = true
  } else {
    rmSync(target.authDir, { recursive: true, force: true })
  }

  emitOk({ loggedIn: false, viaDaemon }, options, () => 'Logged out. Credentials removed.')
}
