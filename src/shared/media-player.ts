import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

interface Launcher {
  cmd: string
  args: string[]
}

/** Try each launcher in turn until one spawns without an immediate error. */
function spawnFirst(launchers: Launcher[], failureMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tryNext = (index: number) => {
      if (index >= launchers.length) {
        return reject(new Error(failureMessage))
      }
      const launcher = launchers[index]!
      try {
        const proc = spawn(launcher.cmd, launcher.args, { stdio: 'ignore', detached: true })
        proc.on('error', () => tryNext(index + 1))
        proc.unref()
        resolve()
      } catch {
        tryNext(index + 1)
      }
    }

    tryNext(0)
  })
}

function requireFile(filePath: string): void {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
}

export function playAudio(filePath: string): Promise<void> {
  return Promise.resolve().then(() => {
    requireFile(filePath)
    return spawnFirst(
      [
        { cmd: 'mpv', args: ['--no-terminal', filePath] },
        { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath] },
        { cmd: 'aplay', args: [filePath] },
        { cmd: 'xdg-open', args: [filePath] },
      ],
      'No audio player found (install mpv or ffplay)',
    )
  })
}

export function openImageViewer(filePath: string): Promise<void> {
  return Promise.resolve().then(() => {
    requireFile(filePath)
    return spawnFirst(imageViewerLaunchers(filePath), 'No image viewer found (install xdg-open or feh)')
  })
}

/** Open any file (PDF, document, video, ...) with the desktop handler. */
export function openPath(filePath: string): Promise<void> {
  return Promise.resolve().then(() => {
    requireFile(filePath)
    return spawnFirst(openLaunchers(filePath), `No application found to open ${filePath}`)
  })
}

function imageViewerLaunchers(filePath: string): Launcher[] {
  if (process.platform === 'darwin') return [{ cmd: 'open', args: [filePath] }]
  return [
    { cmd: 'xdg-open', args: [filePath] },
    { cmd: 'feh', args: [filePath] },
    { cmd: 'eog', args: [filePath] },
    { cmd: 'display', args: [filePath] },
  ]
}

function openLaunchers(filePath: string): Launcher[] {
  if (process.platform === 'darwin') return [{ cmd: 'open', args: [filePath] }]
  if (process.platform === 'win32') return [{ cmd: 'cmd', args: ['/c', 'start', '', filePath] }]
  return [
    { cmd: 'xdg-open', args: [filePath] },
    { cmd: 'gio', args: ['open', filePath] },
    { cmd: 'sensible-browser', args: [filePath] },
  ]
}

export function osc8Hyperlink(url: string, text: string): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`
}
