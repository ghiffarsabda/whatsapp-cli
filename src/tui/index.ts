import { render } from 'ink'
import { createElement } from 'react'
import type { MeInfo } from '../shared/protocol.js'
import { ensureDaemon } from '../cli/ensure-daemon.js'
import { call } from '../cli/ipc-client.js'
import type { StatusResult } from '../cli/commands/status.js'
import { App } from './app.js'

/**
 * Launch the interactive TUI.
 *
 * Ink is imported statically here, but this module is only ever reached through
 * a dynamic import from `wa tui`, so no other command pays for React or the
 * flexbox engine.
 */
export async function runTui(): Promise<void> {
  await ensureDaemon()
  const status = await call<StatusResult>('status')

  if (!status.loggedIn) {
    process.stderr.write('Not logged in. Run `wa login` first, then start the TUI again.\n')
    process.exitCode = 3
    return
  }

  const instance = render(
    createElement(App, { me: status.me as MeInfo | null, initialConnection: status.connection }),
    { alternateScreen: true, exitOnCtrlC: false },
  )
  await instance.waitUntilExit()
}
