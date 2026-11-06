#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { definitions, schema, searchCommands, validateArgs } from '../web/agent-protocol.js'

const defaultSession = () =>
  process.env.OPENLR_AGENT_FILE ||
  path.join(
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'OpenLR',
    'agent.json'
  )
const localCommands = {
  open: {
    summary: 'Connect to the current workspace or launch the packaged desktop application.',
    usage: 'openlr open [--app executable] [--session file] [--dry-run]'
  },
  watch: {
    summary: 'Observe live workspace or export progress revisions as JSON, optionally saving screenshots.',
    usage: 'openlr watch [--command state|export-status] [--session file] [--images directory] [--count n]',
    output: 'One JSON record per observed revision. Fast consecutive changes may be coalesced.'
  }
}
const help = {
  usage: 'openlr <command> [--name value] [--args JSON] [--dry-run]',
  discovery: ['openlr cli search "export image"', 'openlr schema edit', 'openlr <command> --help'],
  examples: [
    'openlr state',
    'openlr import C:/Photos/photo.jpg',
    'openlr edit --key Exposure --value 0.5',
    'openlr preview --output preview.png',
    'openlr export --format image/png --output edited.png'
  ],
  options: {
    '--timeout': 'Optional request deadline in seconds',
    '--capture': 'Save a PNG of the live desktop after a data command and return both results',
    '--args': 'JSON argument object; --body is an alias',
    '--dry-run': 'Validate and print the request without contacting the GUI',
    '--output': 'Destination for image bytes; refuses an existing file unless --force',
    '--output-dir': 'Destination folder for export-selection; existing names receive numbered suffixes',
    '--force': 'Allow overwriting the output file',
    '--session': 'Agent session file; default is the platform user config/OpenLR/agent.json'
  },
  workflow:
    'Search, inspect schema, dry-run, then run. Commands operate on the currently running native GUI. JSON goes to stdout; errors go to stderr with a nonzero exit. Images default to a generated .workspace/agent-results file.',
  commands: [...Object.keys(definitions), ...Object.keys(localCommands)]
}

function parseValue(text, rule) {
  if (rule?.type === 'number' || rule?.type === 'integer') {
    if (text.trim() === '') throw new Error('Expected a number')
    return Number(text)
  }
  if (rule?.type === 'boolean') {
    if (!['true', 'false'].includes(text)) throw new Error('Expected true or false')
    return text === 'true'
  }
  if (rule?.type === 'array' || rule?.type === 'object') return JSON.parse(text)
  if (rule?.oneOf) {
    if (text === 'null' || /^[{[]/.test(text.trim())) return JSON.parse(text)
    if (text === 'true' || text === 'false') return text === 'true'
    if (text.trim() !== '' && Number.isFinite(Number(text))) return Number(text)
  }
  return text
}

export function parse(argv) {
  const tokens = [...argv],
    command = tokens.shift()
  if (!command || ['help', '--help', '-h'].includes(command)) return { local: help }
  if (command === 'cli') {
    if (tokens.shift() !== 'search' || tokens.length !== 1)
      throw new Error('Usage: openlr cli search "task description"')
    return { local: searchCommands(tokens[0], { ...definitions, ...localCommands }) }
  }
  if (command === 'schema') {
    if (tokens.length !== 1) throw new Error('Usage: openlr schema <command>')
    return { local: Object.hasOwn(localCommands, tokens[0]) ? localCommands[tokens[0]] : schema(tokens[0]) }
  }
  if (command === 'open') {
    const request = { command, session: defaultSession(), app: process.env.OPENLR_APP }
    while (tokens.length) {
      const key = tokens.shift()
      if (key === '--help' || key === '-h') return { local: localCommands[command] }
      if (key === '--dry-run') {
        request.dryRun = true
        continue
      }
      if (!['--app', '--session'].includes(key) || !tokens.length)
        throw Error('Expected --app or --session followed by a path')
      request[key.slice(2)] = tokens.shift()
    }
    return request
  }
  if (command === 'watch') {
    const options = { session: defaultSession(), command }
    while (tokens.length) {
      const key = tokens.shift()
      if (key === '--help' || key === '-h') return { local: localCommands[command] }
      const value = tokens.shift()
      if (!value || !['--session', '--count', '--images', '--command'].includes(key))
        throw Error('Expected --session, --count, --images or --command followed by its value')
      options[key === '--command' ? 'observe' : key.slice(2)] = value
    }
    if (options.count !== undefined) {
      options.count = Number(options.count)
      if (!Number.isSafeInteger(options.count) || options.count < 1)
        throw Error('Count must be a positive integer')
    }
    if (options.observe !== undefined && !['state', 'export-status'].includes(options.observe))
      throw Error('Watch command must be state or export-status')
    return options
  }
  const definition = schema(command)
  let args = {},
    output,
    capture,
    timeout,
    session = defaultSession(),
    dryRun = false,
    force = false
  const files = [],
    parameters = definition.parameters.properties
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--help' || token === '-h') return { local: definition }
    if (token === '--dry-run') {
      dryRun = true
      continue
    }
    if (token === '--force') {
      force = true
      continue
    }
    if (token === '--') {
      if (command !== 'import') throw new Error('Positional arguments are only supported for import')
      files.push(...tokens.slice(i + 1))
      break
    }
    if (!token.startsWith('--')) {
      if (command !== 'import') throw new Error('Unexpected positional argument: ' + token)
      files.push(token)
      continue
    }
    const equals = token.indexOf('='),
      key = token.slice(2, equals < 0 ? undefined : equals)
    const value = equals < 0 ? tokens[++i] : token.slice(equals + 1)
    if (value === undefined) throw new Error('Missing value for --' + key)
    if (key === 'args' || key === 'body') {
      const parsed = JSON.parse(value)
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
        throw new Error('--args must be a JSON object')
      args = { ...args, ...parsed }
    } else if (key === 'session') session = value
    else if (key === 'timeout') {
      timeout = Number(value)
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw Error('Timeout must be a positive number of seconds')
    } else if (key === 'output') output = value
    else if (key === 'output-dir') {
      if (command !== 'export-selection') throw Error('--output-dir requires export-selection')
      if (!value.trim()) throw Error('--output-dir requires a directory path')
      args.outputDirectory = path.resolve(value)
    } else if (key === 'capture') capture = value
    else if (key === 'file' && command === 'import') files.push(value)
    else if (Object.hasOwn(parameters, key)) args[key] = parseValue(value, parameters[key])
    else throw new Error('Unknown option: --' + key)
  }
  if (command === 'import') {
    if (files.length && Object.hasOwn(args, 'files'))
      throw new Error('Use either import paths or --args files')
    if (files.length) args.files = files
  }
  if (command === 'export-selection') {
    if (output || force)
      throw Error(
        'export-selection uses --output-dir and numbered filenames; --output and --force are not supported'
      )
    if (args.outputDirectory !== undefined) {
      if (typeof args.outputDirectory !== 'string' || !args.outputDirectory.trim())
        throw Error('--output-dir requires a directory path')
      args.outputDirectory = path.resolve(args.outputDirectory)
    }
  }
  // Edit values depend on the selected key; an aspect is an enum string.
  if (command === 'edit' && args.key === 'aspect' && typeof args.value === 'number')
    args.value = String(args.value)
  validateArgs(command, args)
  if (command === 'import' && args.files.some((file) => typeof file !== 'string' || !file))
    throw new Error('Import files must be nonempty local paths')
  const fileResult = Boolean(definition.returns)
  if (output && !fileResult) throw new Error('--output requires an image command')
  if (capture && (fileResult || capture === '-'))
    throw new Error('--capture needs a file path and a data-returning command')
  return { command, args, output, capture, timeout, session, dryRun, force }
}

export async function connect(filename) {
  let config
  try {
    config = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    throw new Error(
      'Cannot read the GUI agent session. Start OpenLR first. Session: ' +
        filename +
        ' (' +
        error.message +
        ')'
    )
  }
  const url = new URL(config.url)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    !config.token ||
    config.version !== 1
  )
    throw new Error('Invalid local GUI agent session')
  return { url, token: config.token, pid: config.pid }
}

const mimeTypes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.jxl': 'image/jxl',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/matroska'
}
async function importPayload(files) {
  const result = []
  for (const filename of files) {
    const info = await stat(filename)
    if (!info.isFile()) throw new Error('Not a file: ' + filename)
    const bytes = await readFile(filename)
    result.push({
      name: path.basename(filename),
      type: mimeTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      lastModified: info.mtimeMs,
      base64: bytes.toString('base64')
    })
  }
  return result
}

async function workspaceExecutable(app) {
  const name =
    process.platform === 'win32' ? 'OpenLR.exe' : process.platform === 'darwin' ? 'OpenLR' : 'openlr'
  const paths = app
    ? [path.resolve(app)]
    : [
        fileURLToPath(new URL('../' + name, import.meta.url)),
        fileURLToPath(new URL('../../MacOS/' + name, import.meta.url)),
        fileURLToPath(
          new URL(
            '../build/' +
              (process.platform === 'win32'
                ? 'windows-amd64'
                : process.platform === 'darwin'
                  ? 'darwin-universal/OpenLR.app/Contents/MacOS'
                  : 'linux-' + (process.arch === 'x64' ? 'amd64' : process.arch)) +
              '/' +
              name,
            import.meta.url
          )
        )
      ]
  for (const candidate of paths) {
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {}
  }
  throw Error('Cannot locate OpenLR. Pass --app with the desktop executable path.')
}

async function agentAvailable(session) {
  try {
    const { url, token } = await connect(session)
    const response = await fetch(new URL('/health', url), {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(4000)
    })
    const health = await response.json()
    return response.ok && health.ok === true && health.version === 1
  } catch {
    return false
  }
}

async function launchWorkspace({ session, app, dryRun }) {
  if (dryRun) return { dryRun: true, executable: await workspaceExecutable(app), session }
  const readState = async () => {
    const connection = await connect(session)
    const { result } = await requestAgent(connection, {
      command: 'state',
      args: { summary: true },
      timeout: 4
    })
    return { state: result, pid: connection.pid }
  }
  try {
    const { state } = await readState()
    return { launched: false, state }
  } catch {}

  // The broker can answer health checks while the current renderer is starting.
  let host, launchError
  if (!(await agentAvailable(session))) {
    host = spawn(await workspaceExecutable(app), [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, OPENLR_AGENT_FILE: session }
    })
    host.once('error', (error) => {
      launchError = error
    })
    host.unref()
  }
  const until = Date.now() + 45000
  while (Date.now() < until) {
    if (launchError) throw launchError
    try {
      const { state, pid } = await readState()
      // Another primary can publish its session during a concurrent launch.
      return host?.pid && host.pid === pid ? { launched: true, pid, state } : { launched: false, state }
    } catch {}
    if (host && (host.exitCode !== null || host.signalCode))
      throw Error('OpenLR exited before the workspace connected')
    await delay(150)
  }
  throw Error(
    host
      ? 'The desktop started but its workspace is still unavailable'
      : 'The running OpenLR workspace is still unavailable'
  )
}

async function requestAgent(connection, { command, args, capture, timeout }) {
  let response
  try {
    response = await fetch(new URL('/command', connection.url), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args, capture: Boolean(capture) }),
      signal: timeout ? AbortSignal.timeout(Math.round(timeout * 1000)) : undefined
    })
  } catch (error) {
    throw new Error('Cannot reach the live OpenLR GUI agent: ' + (error.cause?.message || error.message))
  }
  const envelope = await response.json()
  if (!response.ok || !envelope.ok) {
    const error = new Error(
      envelope.error?.message || envelope.error || 'Agent returned HTTP ' + response.status
    )
    if (envelope.error?.details) error.details = envelope.error.details
    throw error
  }
  return envelope
}
export async function execute(request) {
  if (Object.hasOwn(request, 'local')) return request.local
  if (request.command === 'open') return launchWorkspace(request)
  const { command, output, capture, session, dryRun, force } = request
  if (dryRun)
    return {
      dryRun: true,
      transport: 'live GUI agent',
      request: {
        command,
        args: Object.fromEntries(
          Object.entries(request.args).map(([key, value]) => [
            key,
            /password|token|secret/i.test(key) ? '[redacted]' : value
          ])
        )
      },
      ...(output ? { output } : {}),
      force
    }
  const connection = await connect(session)
  const args =
    command === 'import'
      ? { ...request.args, files: await importPayload(request.args.files) }
      : { ...request.args }
  for (const [key, rule] of Object.entries(schema(command).parameters.properties))
    if (rule.localFile && typeof args[key] === 'string') args[key] = (await importPayload([args[key]]))[0]
  if (command === 'sync' && !args.password && process.env.OPENLR_DAV_PASSWORD)
    args.password = process.env.OPENLR_DAV_PASSWORD
  const envelope = await requestAgent(connection, { command, args, capture, timeout: request.timeout })
  const result = envelope.result
  if (capture) {
    if (!envelope.frame) throw Error('The desktop did not return a workspace image')
    return { result, selected: envelope.selected, frame: await writeImage(envelope.frame, capture, force) }
  }
  if (result?.kind !== 'file') return result
  const saved = await writeImage(result, output, force)
  if (['export', 'export-previous'].includes(command) && result.exportSettings) {
    try {
      await execute({
        command: 'export-settings',
        args: result.exportSettings,
        session,
        timeout: request.timeout
      })
    } catch (error) {
      const destination = saved.rawOutput
        ? 'Export bytes were written to stdout'
        : 'File was saved to ' + saved.path
      throw new Error(destination + ', but export settings could not be remembered: ' + error.message)
    }
  }
  return saved
}
async function writeImage(result, output, force) {
  if (typeof result.base64 !== 'string') throw new Error('Invalid image response')
  const bytes = Buffer.from(result.base64, 'base64')
  if (bytes.length !== result.bytes || bytes.length === 0) throw new Error('Incomplete image response')
  let destination
  if (output === '-') {
    if (process.stdout.isTTY)
      throw new Error('Use --output <file> for images, or redirect --output - to a file')
    await new Promise((resolve, reject) => {
      const failed = (error) => reject(error)
      process.stdout.once('error', failed)
      try {
        process.stdout.write(bytes, (error) => {
          if (error) reject(error)
          else {
            process.stdout.removeListener('error', failed)
            resolve()
          }
        })
      } catch (error) {
        process.stdout.removeListener('error', failed)
        reject(error)
      }
    })
    return { rawOutput: true }
  }
  if (output) destination = path.resolve(output)
  else {
    const directory = path.resolve('.workspace', 'agent-results')
    await mkdir(directory, { recursive: true })
    destination = path.join(
      directory,
      Date.now() +
        '-' +
        crypto.randomUUID().slice(0, 8) +
        '-' +
        path.basename(result.filename || 'preview.png')
    )
  }
  await writeFile(destination, bytes, { flag: force ? 'w' : 'wx' })
  return { path: destination, filename: result.filename, mimeType: result.mimeType, bytes: bytes.length }
}

export async function watch(request, onUpdate) {
  const command = request.observe ?? 'state'
  if (!['state', 'export-status'].includes(command))
    throw Error('Watch command must be state or export-status')
  const connection = await connect(request.session)
  if (request.images) await mkdir(request.images, { recursive: true })
  let after = -1
  for (let i = 0; request.count === undefined || i < request.count; i++) {
    const url = new URL('/changes', connection.url)
    url.searchParams.set('after', after)
    const response = await fetch(url, { headers: { Authorization: 'Bearer ' + connection.token } })
    if (!response.ok) throw Error('Workspace observer returned HTTP ' + response.status)
    const { revision } = await response.json()
    if (!Number.isSafeInteger(revision) || revision <= after) throw Error('Invalid workspace revision')
    after = revision
    const capture = request.images
      ? path.resolve(request.images, revision + '-' + crypto.randomUUID().slice(0, 8) + '.png')
      : null
    const state = await execute({
      command,
      args: command === 'state' ? { summary: true } : {},
      session: request.session,
      capture
    })
    await onUpdate({ revision, ...(command === 'export-status' && !capture ? { result: state } : state) })
  }
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const request = parse(argv)
    if (request.command === 'watch') {
      await watch(request, (update) => process.stdout.write(JSON.stringify(update) + '\n'))
      return
    }
    const result = await execute(request)
    if (!result?.rawOutput) process.stdout.write(JSON.stringify(result ?? null, null, 2) + '\n')
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: 'OPENLR_CLI_ERROR',
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        }
      }) + '\n'
    )
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
