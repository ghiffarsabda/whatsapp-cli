import { usage } from '../../shared/errors.js'
import type { OutputOptions } from '../output.js'

/**
 * `wa tui` — interactive terminal UI.
 *
 * The terminal check happens *before* the dynamic import so that a piped or
 * redirected invocation never loads React or Ink at all.
 */
export async function tuiCommand(options: OutputOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw usage(
      'The TUI needs an interactive terminal (stdin and stdout must be a TTY)',
      'Use `wa chats`, `wa read`, and `wa watch` for non-interactive use.',
    )
  }

  if (options.format === 'json') {
    throw usage('The TUI cannot run with --json output')
  }

  const { runTui } = await import('../../tui/index.js')
  await runTui()
}
