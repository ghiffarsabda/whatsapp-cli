import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { ensureParentDir } from '../shared/atomic.js'
import { getLogger } from '../shared/logger.js'
import { paths, setDataDirOverride } from '../shared/paths.js'
import { defaultState, writeState } from '../shared/state-file.js'
import type { DaemonState } from '../shared/protocol.js'
import { Store } from './store.js'
import { WaConnection } from './baileys.js'
import { IpcServer } from './ipc-server.js'
import { buildHandlers } from './methods.js'

interface DaemonArgs {
  dataDir?: string
  verbose: boolean
}

function parseArgs(argv: string[]): DaemonArgs {
  const args: DaemonArgs = { verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--data-dir' && argv[i + 1]) {
      args.dataDir = argv[i + 1]
      i += 1
    } else if (arg?.startsWith('--data-dir=')) {
      args.dataDir = arg.slice('--data-dir='.length)
    } else if (arg === '--verbose' || arg === '-v') {
      args.verbose = true
    }
  }
  return args
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** True when another daemon is already answering on the socket. */
function probeSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    const done = (result: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

function readLockPid(lockFile: string): number | null {
  if (!existsSync(lockFile)) return null
  const pid = Number(readFileSync(lockFile, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.dataDir) setDataDirOverride(args.dataDir)
  if (args.verbose) process.env.WHATSAPP_CLI_LOG_LEVEL = 'debug'

  const logger = getLogger({ verbose: args.verbose })
  const target = paths()

  // Another daemon already serving: nothing to do.
  if (await probeSocket(target.socketPath)) {
    logger.info('daemon already running; exiting')
    process.exit(0)
  }

  // A stale lock from a dead process must not block a restart.
  const lockPid = readLockPid(target.lockFile)
  if (lockPid !== null && lockPid !== process.pid && isProcessAlive(lockPid)) {
    logger.warn({ lockPid }, 'lock held by a live process that is not answering; taking over')
  }
  ensureParentDir(target.lockFile)
  writeFileSync(target.lockFile, String(process.pid), { mode: 0o600 })

  const store = new Store(target.messagesFile, target.chatsFile)
  await store.load()

  let ipc: IpcServer | null = null
  let shuttingDown = false

  const persist = (state: DaemonState) => {
    writeState(state)
    ipc?.broadcastStatus(state)
  }

  const connection = new WaConnection({
    authDir: target.authDir,
    mediaDir: target.mediaDir,
    store,
    logger,
    onStateChange: persist,
    onMessage: (record) => ipc?.broadcastMessage(record),
  })

  const shutdown = async (code: number, reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ reason }, 'shutting down')

    await connection.stop()
    store.flushSnapshot()
    await ipc?.stop()

    try {
      rmSync(target.lockFile, { force: true })
    } catch {
      // Best effort.
    }
    process.exit(code)
  }

  ipc = new IpcServer(
    target.socketPath,
    buildHandlers({
      store,
      connection,
      requestShutdown: () => {
        void shutdown(0, 'requested via ipc')
      },
      subscriberCount: () => ipc?.subscriberCount ?? 0,
    }),
  )
  await ipc.start()

  // Give clients something to read before the socket is up.
  persist(connection.getState() ?? defaultState(process.pid))

  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'))
  process.on('SIGINT', () => void shutdown(0, 'SIGINT'))
  process.on('uncaughtException', (error) => logger.error({ error }, 'uncaught exception'))
  process.on('unhandledRejection', (error) => logger.error({ error }, 'unhandled rejection'))

  const connectWithRetry = async (): Promise<void> => {
    try {
      await connection.start()
    } catch (error) {
      logger.error({ error }, 'failed to start connection; retrying')
      const state = connection.getState()
      persist({
        ...state,
        connection: 'close',
        lastDisconnect: {
          statusCode: null,
          message: error instanceof Error ? error.message : String(error),
          at: new Date().toISOString(),
        },
        reconnect: { attempts: state.reconnect.attempts + 1, nextAt: null },
      })
      setTimeout(() => void connectWithRetry(), 5_000)
    }
  }
  await connectWithRetry()
}

main().catch((error: unknown) => {
  const logger = getLogger()
  logger.error({ error }, 'daemon failed to start')
  process.exit(1)
})
