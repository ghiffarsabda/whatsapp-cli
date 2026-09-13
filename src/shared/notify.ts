import { spawn } from 'node:child_process'

export interface NotifyCommand {
  cmd: string
  args: string[]
}

/**
 * The native notification command for a platform, or null when only a terminal
 * bell is available.
 */
export function notificationCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): NotifyCommand | null {
  if (platform === 'darwin') {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`
    return { cmd: 'osascript', args: ['-e', script] }
  }
  if (platform === 'win32') return null
  return { cmd: 'notify-send', args: ['--app-name=whatsapp-cli', title, body] }
}

function ring(): void {
  try {
    process.stderr.write('\u0007')
  } catch {
    // stderr may be closed; nothing else to do.
  }
}

/**
 * Fire a desktop notification, falling back to the terminal bell when no
 * notifier is installed (or it fails). Never throws and never blocks.
 */
export function sendNotification(title: string, body: string): void {
  if (process.env.WHATSAPP_CLI_NO_NOTIFY === '1') return

  const spec = notificationCommand(process.platform, title, body)
  if (!spec) {
    ring()
    return
  }

  try {
    const proc = spawn(spec.cmd, spec.args, { stdio: 'ignore', detached: true })
    proc.on('error', ring)
    proc.on('exit', (code) => {
      if (code !== 0) ring()
    })
    proc.unref()
  } catch {
    ring()
  }
}
