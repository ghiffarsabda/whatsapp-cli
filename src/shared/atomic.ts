import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Write via a temp sibling + rename so readers never observe a partial file. */
export function writeFileAtomic(target: string, data: string, mode = 0o600): void {
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, target)
}

/** Create a directory that only the current user can enter. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best effort: some filesystems (and Windows) do not support this.
  }
}

export function ensureParentDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}
