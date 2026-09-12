#!/usr/bin/env node
import { Command, CommanderError } from 'commander'
import { setDataDirOverride } from '../shared/paths.js'
import { VERSION } from '../shared/version.js'
import { chatsCommand } from '../cli/commands/chats.js'
import { daemonCommand, type DaemonAction } from '../cli/commands/daemon.js'
import { loginCommand } from '../cli/commands/login.js'
import { logoutCommand } from '../cli/commands/logout.js'
import { readCommand } from '../cli/commands/read.js'
import { schemaCommand } from '../cli/commands/schema.js'
import { searchCommand } from '../cli/commands/search.js'
import { sendCommand } from '../cli/commands/send.js'
import { statusCommand } from '../cli/commands/status.js'
import { tuiCommand } from '../cli/commands/tui.js'
import { waitCommand } from '../cli/commands/wait.js'
import { watchCommand } from '../cli/commands/watch.js'
import { emitError, resolveOutputOptions, type OutputOptions } from '../cli/output.js'

const program = new Command()

program
  .name('wa')
  .description('Terminal WhatsApp client with persistent login (text messages only)')
  .version(VERSION, '-V, --version')
  .option('--json', 'emit a single JSON object on stdout')
  .option('--format <format>', 'output format: json or text')
  .option('--no-color', 'disable ANSI color')
  .option('--timeout <ms>', 'request timeout in milliseconds')
  .option('--data-dir <dir>', 'override the data directory')
  .option('--quiet', 'suppress success output in text mode')
  .option('--verbose', 'verbose daemon logging')
  .exitOverride()

// Without this, a flag defined on both the program and a subcommand (--timeout,
// --json, ...) is swallowed by the program and the subcommand never sees it.
program.enablePositionalOptions()

program.configureOutput({
  writeErr: (text) => process.stderr.write(text),
  outputError: (text) => process.stderr.write(text),
})

/** Shared flags are accepted both before and after the subcommand name. */
function addSharedFlags(command: Command): Command {
  return command
    .option('--json', 'emit a single JSON object on stdout')
    .option('--format <format>', 'output format: json or text')
    .option('--no-color', 'disable ANSI color')
    .option('--quiet', 'suppress success output in text mode')
    .option('--timeout <ms>', 'request timeout in milliseconds')
    .option('--data-dir <dir>', 'override the data directory')
}

/**
 * A subcommand's own default must not shadow a global flag the user actually
 * passed, so only non-default sources are preferred.
 */
function pick(command: Command, key: string): unknown {
  const localSource = command.getOptionValueSource(key)
  if (localSource && localSource !== 'default') return command.getOptionValue(key)
  const globalSource = program.getOptionValueSource(key)
  if (globalSource && globalSource !== 'default') return program.getOptionValue(key)
  return command.getOptionValue(key) ?? program.getOptionValue(key)
}

function outputFor(command: Command): OutputOptions {
  return resolveOutputOptions({
    json: pick(command, 'json') === true,
    format: pick(command, 'format') as string | undefined,
    color: pick(command, 'color') !== false,
    quiet: pick(command, 'quiet') === true,
  })
}

function dataDirFor(command: Command): string | undefined {
  const value = pick(command, 'dataDir')
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Apply process-wide settings, translate errors into the documented exit codes. */
async function run(command: Command, action: () => Promise<void>): Promise<void> {
  const output = outputFor(command)
  const dataDir = dataDirFor(command)
  if (dataDir) setDataDirOverride(dataDir)

  const timeout = pick(command, 'timeout')
  if (timeout !== undefined) process.env.WHATSAPP_CLI_TIMEOUT = String(timeout)
  if (command.parent?.opts().verbose || program.opts().verbose) {
    process.env.WHATSAPP_CLI_LOG_LEVEL = 'debug'
  }

  try {
    await action()
  } catch (error) {
    process.exitCode = emitError(error, output)
  }
}

addSharedFlags(
  program
    .command('login')
    .description('link this device (one-time; credentials persist on disk)'),
)
  .option('--phone <number>', 'pair with a phone number instead of a QR code')
  .option('--wait', 'in JSON mode, wait until linked before returning')
  .action((options, command: Command) =>
    run(command, () => {
      const opts = command.opts()
      return loginCommand(
        { phone: opts.phone, wait: opts.wait, timeout: toNumber(opts.timeout) },
        outputFor(command),
        { dataDir: dataDirFor(command) },
      )
    }),
  )

addSharedFlags(program.command('logout').description('unlink the device and delete credentials'))
  .option('--yes', 'required acknowledgement')
  .action((options, command: Command) =>
    run(command, () =>
      logoutCommand({ yes: command.opts().yes === true }, outputFor(command)),
    ),
  )

addSharedFlags(program.command('status').description('show daemon and connection state')).action(
  (options, command: Command) =>
    run(command, async () => {
      await statusCommand(outputFor(command), { dataDir: dataDirFor(command) })
    }),
)

addSharedFlags(program.command('chats').description('list chats by recent activity'))
  .option('--limit <n>', 'maximum chats to return')
  .option('--search <text>', 'filter by name or JID substring')
  .option('--unread', 'only chats with unread messages')
  .action((options, command: Command) => {
    const opts = command.opts()
    return run(command, () =>
      chatsCommand(
        { limit: toNumber(opts.limit), search: opts.search, unread: opts.unread },
        outputFor(command),
        { dataDir: dataDirFor(command) },
      ),
    )
  })

addSharedFlags(program.command('read').description('read stored messages from a chat'))
  .argument('<chat>', 'JID, phone number, or chat name')
  .option('--limit <n>', 'maximum messages')
  .option('--since <ts>', 'only messages at or after this unix timestamp')
  .option('--before <ts>', 'only messages before this unix timestamp')
  .action((chat: string, options, command: Command) => {
    const opts = command.opts()
    return run(command, () =>
      readCommand(
        chat,
        { limit: toNumber(opts.limit), since: toNumber(opts.since), before: toNumber(opts.before) },
        outputFor(command),
        { dataDir: dataDirFor(command) },
      ),
    )
  })

addSharedFlags(program.command('send').description('send a text message'))
  .argument('<chat>', 'JID, phone number, or chat name')
  .argument('[text]', 'message body, or "-" to read from stdin')
  .option('--body-file <path>', 'read the body from a file')
  .action((chat: string, text: string | undefined, options, command: Command) => {
    const opts = command.opts()
    return run(command, () =>
      sendCommand(
        chat,
        text ?? '-',
        { bodyFile: opts.bodyFile },
        outputFor(command),
        { dataDir: dataDirFor(command) },
      ),
    )
  })

addSharedFlags(program.command('watch').description('stream incoming messages'))
  .argument('[chat]', 'limit to one chat')
  .option('--once', 'exit after the first message')
  .action((chat: string | undefined, options, command: Command) => {
    const opts = command.opts()
    return run(command, () =>
      watchCommand(
        { chat, once: opts.once === true, timeout: toNumber(opts.timeout) },
        outputFor(command),
        { dataDir: dataDirFor(command) },
      ),
    )
  })

addSharedFlags(program.command('wait').description('block until the next inbound message, then print it'))
  .argument('<chat>', 'JID, phone number, or chat name')
  .option('--include-from-me', 'also match messages you sent')
  .action((chat: string, options, command: Command) => {
    const opts = command.opts()
    return run(command, () =>
      waitCommand(
        chat,
        { timeout: toNumber(opts.timeout), includeFromMe: opts.includeFromMe === true },
        outputFor(command),
        { dataDir: dataDirFor(command) },
      ),
    )
  })

addSharedFlags(program.command('search').description('search message text'))
  .argument('<query>', 'case-insensitive substring')
  .option('--chat <chat>', 'limit to one chat')
  .option('--limit <n>', 'maximum matches')
  .option('--since <ts>', 'only messages at or after this unix timestamp')
  .action((query: string, options, command: Command) => {
    const opts = command.opts()
    return run(command, () =>
      searchCommand(
        query,
        { chat: opts.chat, limit: toNumber(opts.limit), since: toNumber(opts.since) },
        outputFor(command),
        { dataDir: dataDirFor(command) },
      ),
    )
  })

addSharedFlags(program.command('daemon').description('control the background daemon'))
  .argument('<action>', 'start | stop | restart | status | logs')
  .option('--lines <n>', 'log tail size for `logs`')
  .option('--follow', 'stream new log lines (logs only)')
  .action((action: string, options, command: Command) => {
    const opts = command.opts()
    return run(command, () =>
      daemonCommand(
        action as DaemonAction,
        { lines: toNumber(opts.lines), follow: opts.follow === true },
        outputFor(command),
        { dataDir: dataDirFor(command) },
      ),
    )
  })

addSharedFlags(program.command('tui').description('interactive terminal UI (requires a TTY)')).action(
  (options, command: Command) =>
    run(command, () => tuiCommand(outputFor(command))),
)

program
  .command('schema')
  .description('print a machine-readable description of this CLI')
  .action(() => run(program, () => schemaCommand()))

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version are successful exits, not usage errors. Commander has
      // already written the message, so do not print it a second time.
      const benign = error.code === 'commander.helpDisplayed' || error.code === 'commander.version'
      process.exitCode = benign ? 0 : 2
      return
    }
    const output = resolveOutputOptions({})
    process.exitCode = emitError(error, output)
  }
}

await main()
