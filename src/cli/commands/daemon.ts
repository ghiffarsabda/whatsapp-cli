import { existsSync, readFileSync, rmSync } from 'node:fs'
import { daemonUnreachable } from '../../shared/errors.js'
import { paths } from '../../shared/paths.js'
import { ensureDaemon } from '../ensure-daemon.js'
import { call, probe } from '../ipc-client.js'
import { emitFrame, emitOk, type OutputOptions } from '../output.js'
import { renderState } from '../render.js'
import type { CommandContext } from './context.js'
import type { StatusResult } from './status.js'

export type DaemonAction = 'start' | 'stop' | 'restart' | 'status' | 'logs'

export interface DaemonFlags {
  follow?: boolean
  lines?: number
}

export async function daemonCommand(
  action: DaemonAction,
  flags: DaemonFlags,
  options: OutputOptions,
  context: CommandContext,
): Promise<void> {
  const target = paths()

  switch (action) {
    case 'start': {
      await ensureDaemon({ dataDir: context.dataDir })
      const state = await call<StatusResult>('status')
      emitOk(state, options, renderState)
      return
    }

    case 'stop': {
      if (!(await probe(target.socketPath))) {
        rmSync(target.lockFile, { force: true })
        emitOk({ stopped: false }, options, () => 'Daemon was not running.')
        return
      }
      try {
        await call('shutdown', {}, { timeoutMs: 10_000 })
      } catch {
        // The daemon exits before replying sometimes; that is fine.
      }
      const gone = await waitForStopped(target.socketPath)
      emitOk({ stopped: gone }, options, () =>
        gone ? 'Daemon stopped.' : 'Daemon did not stop in time.',
      )
      return
    }

    case 'restart': {
      if (await probe(target.socketPath)) {
        try {
          await call('shutdown', {}, { timeoutMs: 10_000 })
        } catch {
          // Ignore; we are restarting anyway.
        }
        await waitForStopped(target.socketPath)
      }
      await ensureDaemon({ dataDir: context.dataDir })
      const state = await call<StatusResult>('status')
      emitOk(state, options, renderState)
      return
    }

    case 'status': {
      const reachable = await probe(target.socketPath)
      if (!reachable) {
        throw daemonUnreachable(`No daemon is running at ${target.socketPath}`)
      }
      const state = await call<StatusResult>('status')
      emitOk(state, options, renderState)
      return
    }

    case 'logs': {
      if (!existsSync(target.logFile)) {
        emitOk({ lines: [] }, options, () => 'No log file yet.')
        return
      }
      const count = flags.lines && flags.lines > 0 ? flags.lines : 50
      const initial = readFileSync(target.logFile, 'utf8').split('\n').filter(Boolean).slice(-count)

      if (!flags.follow) {
        emitOk({ path: target.logFile, lines: initial }, options, (data) => data.lines.join('\n'))
        return
      }

      await followLog(target.logFile, initial, options)
      return
    }
  }
}

/** `daemon logs --follow`: print the tail, then stream new lines as they appear. */
async function followLog(logFile: string, initial: string[], options: OutputOptions): Promise<void> {
  let offset = Buffer.byteLength(readFileSync(logFile, 'utf8'))

  for (const line of initial) {
    if (options.format === 'json') emitFrame({ event: 'log', data: { line } })
    else process.stdout.write(`${line}\n`)
  }

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      let contents: string
      try {
        contents = readFileSync(logFile, 'utf8')
      } catch {
        return
      }
      const size = Buffer.byteLength(contents)
      if (size <= offset) {
        // Handle truncation by an external rotator.
        if (size < offset) offset = 0
        else return
      }
      const fresh = contents.slice(offset)
      offset = size
      for (const line of fresh.split('\n').filter(Boolean)) {
        if (options.format === 'json') emitFrame({ event: 'log', data: { line } })
        else process.stdout.write(`${line}\n`)
      }
    }, 300)

    const stop = () => {
      clearInterval(timer)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

async function waitForStopped(socketPath: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probe(socketPath, 200))) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !(await probe(socketPath, 200))
}
