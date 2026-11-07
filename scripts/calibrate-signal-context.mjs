import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const marker = 'OpenLR forwarded signal sig/code/pc/lr/sp '
const fixturePrefix = 'OpenLR signal fixture '
const hex = '0x[0-9a-f]{16}'

export function parseSignalContext(stderr) {
  const lines = stderr.split(/\r?\n/).filter((line) => line.startsWith(marker))
  assert.equal(lines.length, 1, 'Expected exactly one original-context runtime marker')
  const match = lines[0].match(new RegExp(`^${marker}(${hex}) (${hex}) (${hex}) (${hex}) (${hex}) ?$`))
  assert.ok(match, 'Runtime context marker must contain five complete fixed-width hexadecimal fields')
  const [, sig, code, pc, lr, sp] = match
  return { sig, code, normalizedCode: Number(BigInt.asIntN(32, BigInt(code))), pc, lr, sp }
}

function tool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options
  })
  if (result.error || result.status !== 0)
    throw Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`
    )
  return { command, args, stdout: result.stdout, stderr: result.stderr }
}

async function runProbe(executable, dylib, mode) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [dylib, mode], {
      cwd: root,
      env: { ...process.env, DYLD_PRINT_SEGMENTS: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = '',
      stderr = '',
      expired = false
    const timer = setTimeout(() => {
      expired = true
      child.kill('SIGKILL')
    }, 20_000)
    child.stdout.setEncoding('utf8').on('data', (data) => {
      stdout += data
    })
    child.stderr.setEncoding('utf8').on('data', (data) => {
      stderr += data
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ mode, pid: child.pid, code, signal, expired, stdout, stderr })
    })
  })
}

function fixtureRecords(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(fixturePrefix))
    .map((line) => JSON.parse(line.slice(fixturePrefix.length)))
}

export function validateSignalCalibration(probe, runtimeSiUser) {
  assert.equal(probe.expired, false, `${probe.mode} exceeded its process deadline`)
  assert.equal(probe.code, null, `${probe.mode} must terminate by its original signal`)
  assert.equal(probe.signal, 'SIGTRAP', `${probe.mode} must retain SIGTRAP termination`)
  const records = fixtureRecords(probe.stdout)
  const readyRecords = records.filter((record) => record.kind === 'ready')
  assert.equal(readyRecords.length, 1, 'Missing or duplicate ordinary-context fixture metadata')
  const ready = readyRecords[0]
  assert.equal(ready.mode, ['brk0', 'brk1', 'raise'].indexOf(probe.mode))
  assert.equal(ready.callbacks, 1, 'Foreign pthread must enter and leave Go once before trapping')
  assert.equal(ready.brk0Word, '0xd4200000')
  assert.equal(ready.brk1Word, '0xd4200020')
  const context = parseSignalContext(probe.stderr)
  assert.equal(BigInt(context.sig), 5n)
  assert.notEqual(BigInt(context.pc), 0n)
  assert.notEqual(BigInt(context.lr), 0n)
  assert.ok(
    BigInt(context.sp) >= BigInt(ready.stackLow) && BigInt(context.sp) < BigInt(ready.stackHigh),
    'Original SP must belong to the foreign pthread stack'
  )
  const images = records.filter((record) => record.kind === 'image')
  assert.equal(images.length, 3)
  for (const image of images) {
    assert.match(image.uuid, /^[0-9a-f]{32}$/)
    assert.match(image.arch, /^arm64e?$/)
    assert.ok(
      BigInt(image.address) >= BigInt(image.base) &&
        BigInt(image.address) < BigInt(image.base) + BigInt(image.textSize),
      'Symbol must belong to its mapped image'
    )
  }
  let pcRelation, image
  if (probe.mode.startsWith('brk')) {
    const instruction = BigInt(ready[probe.mode])
    const pc = BigInt(context.pc)
    assert.ok(
      pc === instruction || pc - 4n === instruction,
      `${probe.mode} recorded PC must identify the known instruction at PC or PC-4`
    )
    pcRelation = pc === instruction ? 'pc' : 'pc-4'
    image = images.find((image) => image.role === 'fixture')
    // Go 1.27.3 recognizes BRK #0 at PC-4 only. BRK #1 consequently
    // normalizes to _SI_USER; normalized code alone is not a trap decoder.
    const expectedCode = probe.mode === 'brk0' && pcRelation === 'pc-4' ? ready.trapBreakpoint : runtimeSiUser
    assert.equal(context.normalizedCode, expectedCode, `${probe.mode} normalized si_code changed`)
  } else {
    image = images.find((image) => image.role === 'pthread-kill')
    assert.match(image.path, /\/libsystem_kernel\.dylib$/)
    assert.match(image.symbol, /^_?__pthread_kill$/)
    const offset = BigInt(context.pc) - BigInt(image.address)
    assert.ok(offset >= 0n && offset < 64n, 'raise PC must be in the known __pthread_kill syscall stub')
    assert.equal(
      context.normalizedCode,
      runtimeSiUser,
      'raise must retain the Go-normalized user signal code'
    )
    pcRelation = '__pthread_kill+' + offset
  }
  return { context, ready, images, image, pcRelation }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Signal calibration requires a real macOS host')
  assert.equal(process.arch, 'arm64', 'Signal calibration requires native ARM64 Node and Go execution')
  assert.equal(tool('uname', ['-m']).stdout.trim(), 'arm64')
  assert.ok(process.env.GOROOT, 'Set GOROOT to the disposable diagnostic toolchain first')
  assert.equal(
    process.env.GOTOOLCHAIN,
    'local',
    'Set GOTOOLCHAIN=local to prevent a different runtime being selected'
  )
  const output = path.resolve(process.argv[2] || path.join(root, 'build', 'signal-calibration'))
  await mkdir(output, { recursive: true })
  const goRoot = path.resolve(process.env.GOROOT)
  const osSource = await readFile(path.join(goRoot, 'src', 'runtime', 'os_darwin.go'), 'utf8')
  const userConstant = osSource.match(/\b_SI_USER\s*=\s*(\d+)/)
  assert.ok(userConstant, 'Pinned Go Darwin runtime _SI_USER constant was not found')
  const runtimeSiUser = Number(userConstant[1])
  const fixture = path.join(root, 'scripts', 'fixtures', 'signal-context-probe')
  const dylib = path.join(output, 'signal-context-native.dylib')
  const executable = path.join(output, 'signal-context-probe')
  const build = [
    tool('xcrun', [
      'clang',
      '-arch',
      'arm64',
      '-dynamiclib',
      '-g',
      '-O0',
      '-fno-omit-frame-pointer',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-o',
      dylib,
      path.join(fixture, 'native', 'native.c')
    ]),
    tool(
      path.join(goRoot, 'bin', 'go'),
      ['build', '-trimpath', '-o', executable, path.join(fixture, 'main_darwin.go')],
      { env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64' } }
    )
  ]
  const uuid = tool('xcrun', ['dwarfdump', '--uuid', dylib])
  const disassembly = tool('xcrun', ['otool', '-tvV', dylib])
  assert.match(disassembly.stdout, /_openlr_brk0:[\s\S]*?\bbrk\s+#(?:0x)?0\b/)
  assert.match(disassembly.stdout, /_openlr_brk1:[\s\S]*?\bbrk\s+#(?:0x)?1\b/)
  await writeFile(
    path.join(output, 'build.json'),
    JSON.stringify({ build, uuid, disassembly }, null, 2) + '\n'
  )
  const results = []
  for (const mode of ['brk0', 'brk1', 'raise']) {
    const probe = await runProbe(executable, dylib, mode)
    await writeFile(path.join(output, `${mode}.stdout.log`), probe.stdout)
    await writeFile(path.join(output, `${mode}.stderr.log`), probe.stderr)
    await writeFile(path.join(output, `${mode}.process.json`), JSON.stringify(probe, null, 2) + '\n')
    const verified = validateSignalCalibration(probe, runtimeSiUser)
    const fixtureImage = verified.images.find((image) => image.role === 'fixture')
    assert.ok(
      uuid.stdout.replaceAll('-', '').toLowerCase().includes(fixtureImage.uuid),
      'Loaded fixture UUID must match the inspected Mach-O'
    )
    const symbolication = tool('xcrun', [
      'atos',
      '-arch',
      verified.image.arch,
      '-o',
      verified.image.path,
      '-l',
      verified.image.base,
      verified.context.pc
    ])
    await writeFile(
      path.join(output, `${mode}.symbolication.json`),
      JSON.stringify(symbolication, null, 2) + '\n'
    )
    assert.match(
      symbolication.stdout,
      mode === 'raise' ? /__pthread_kill/ : new RegExp(`openlr_${mode}`),
      'Apple atos must resolve the recorded PC to the independently known trap location'
    )
    const result = { mode, pid: probe.pid, termination: probe.signal, ...verified, symbolication }
    results.push(result)
    console.log('OpenLR signal calibration ' + JSON.stringify(result))
  }
  assert.notEqual(
    results[0].context.normalizedCode,
    results[2].context.normalizedCode,
    'BRK #0 and raise must retain their calibrated normalized-code distinction'
  )
  const report = {
    verified: true,
    platform: process.platform,
    arch: process.arch,
    goVersion: tool(path.join(goRoot, 'bin', 'go'), ['version']).stdout.trim(),
    runtimeSiUser,
    headerSiUser: results[0].ready.siUser,
    note: 'The marker records Go-normalized si_code before raisebadsignal changes disposition or reraises. BRK #1 shares the user code under this runtime; PC and instruction evidence distinguish it.',
    results
  }
  await writeFile(path.join(output, 'calibration.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Signal context calibration passed: ${path.join(output, 'calibration.json')}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.stack || error)
    process.exitCode = 1
  })
