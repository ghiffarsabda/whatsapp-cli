import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export function playAudio(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(filePath)) {
      return reject(new Error(`Audio file not found: ${filePath}`))
    }

    const players = [
      { cmd: 'mpv', args: ['--no-terminal', filePath] },
      { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath] },
      { cmd: 'aplay', args: [filePath] },
      { cmd: 'xdg-open', args: [filePath] },
    ]

    function tryNext(index: number) {
      if (index >= players.length) {
        return reject(new Error('No audio player found (install mpv or ffplay)'))
      }
      const player = players[index]!
      try {
        const proc = spawn(player.cmd, player.args, { stdio: 'ignore', detached: true })
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

export function openImageViewer(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(filePath)) {
      return reject(new Error(`Image file not found: ${filePath}`))
    }

    const viewers = [
      { cmd: 'xdg-open', args: [filePath] },
      { cmd: 'feh', args: [filePath] },
      { cmd: 'eog', args: [filePath] },
      { cmd: 'display', args: [filePath] },
    ]

    function tryNext(index: number) {
      if (index >= viewers.length) {
        return reject(new Error('No image viewer found (install xdg-open or feh)'))
      }
      const viewer = viewers[index]!
      try {
        const proc = spawn(viewer.cmd, viewer.args, { stdio: 'ignore', detached: true })
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

export function osc8Hyperlink(url: string, text: string): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`
}
