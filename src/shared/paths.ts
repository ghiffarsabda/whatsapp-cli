import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Paths {
  dataDir: string
  configDir: string
  authDir: string
  messagesFile: string
  chatsFile: string
  stateFile: string
  logFile: string
  lockFile: string
  socketPath: string
  mediaDir: string
}

let dataDirOverride: string | undefined

export function setDataDirOverride(dir: string | undefined): void {
  dataDirOverride = dir
}

function resolveDataDir(): { dir: string; explicit: boolean } {
  if (dataDirOverride) return { dir: dataDirOverride, explicit: true }
  const fromEnv = process.env.WHATSAPP_CLI_DATA_DIR
  if (fromEnv) return { dir: fromEnv, explicit: true }
  const xdg = process.env.XDG_DATA_HOME
  return {
    dir: join(xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.local', 'share'), 'whatsapp-cli'),
    explicit: false,
  }
}

function resolveSocketPath(dataDir: string, dataDirIsExplicit: boolean): string {
  const fromEnv = process.env.WHATSAPP_CLI_SOCKET
  if (fromEnv) return fromEnv
  // An explicit data dir owns its socket, so isolated instances cannot collide
  // over a shared runtime directory.
  const runtime = process.env.XDG_RUNTIME_DIR
  if (dataDirIsExplicit || !runtime || runtime.trim() === '') return join(dataDir, 'daemon.sock')
  return join(runtime, 'whatsapp-cli', 'daemon.sock')
}

export function paths(): Paths {
  const { dir: dataDir, explicit } = resolveDataDir()
  return {
    dataDir,
    configDir: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'whatsapp-cli'),
    authDir: join(dataDir, 'auth'),
    messagesFile: join(dataDir, 'messages.jsonl'),
    chatsFile: join(dataDir, 'chats.json'),
    stateFile: join(dataDir, 'state.json'),
    logFile: join(dataDir, 'daemon.log'),
    lockFile: join(dataDir, 'daemon.lock'),
    socketPath: resolveSocketPath(dataDir, explicit),
    mediaDir: join(dataDir, 'media'),
  }
}
