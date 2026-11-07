import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const entry = fileURLToPath(import.meta.url)
const nativeError = (error) => ({
  name: error?.name ?? 'Error',
  message: error?.message ?? String(error),
  ...(typeof error?.code === 'string' || typeof error?.code === 'number' ? { code: error.code } : {}),
  ...(typeof error?.stack === 'string' ? { stack: error.stack } : {})
})

async function within(operation, milliseconds, message) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error(message)), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Use the provisioned binding directly only to diagnose its individual startup
// phases. Application instrumentation continues to belong to REA.
async function worker({ mode, binding, pid, nonce }) {
  assert.ok(['device', 'control'].includes(mode))
  assert.ok(path.isAbsolute(binding))
  if (mode === 'control') assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const started = performance.now()
  const record = (event) =>
    console.log(
      JSON.stringify({ fridaStartup: 1, mode, elapsedMs: Math.round(performance.now() - started), ...event })
    )
  const fulfilled = new Set()
  async function phase(name, run) {
    const began = performance.now()
    record({ event: 'started', phase: name })
    try {
      const value = await run()
      fulfilled.add(name)
      record({ event: 'fulfilled', phase: name, phaseElapsedMs: Math.round(performance.now() - began) })
      return value
    } catch (error) {
      record({
        event: 'rejected',
        phase: name,
        phaseElapsedMs: Math.round(performance.now() - began),
        error: nativeError(error)
      })
      throw error
    }
  }
  let manager,
    session,
    script,
    onMessage,
    primary,
    marker = false,
    scriptErrors = false
  const cleanupErrors = []
  try {
    const frida = await phase('import', () => import(pathToFileURL(binding).href))
    manager = await phase('manager', () => frida.getDeviceManager())
    const device = await phase('device-lookup', () => manager.getDeviceById('local', 1000))
    record({ event: 'device-selected', local: device.id === 'local' })
    assert.equal(device.id, 'local')
    if (mode === 'control') {
      if (typeof device.getProcessByPid === 'function') {
        const selected = await phase('target-lookup', () => device.getProcessByPid(pid))
        assert.equal(selected.pid, pid, 'Exact lookup returned another process')
      } else record({ event: 'unavailable', phase: 'target-lookup' })
      session = await phase('attach', () => device.attach(pid))
      assert.equal(session.pid, pid, 'Session belongs to another process')
      let received
      const message = new Promise((resolve) => (received = resolve))
      const source = `send({fridaStartupControl:1,pid:Process.id,nonce:${JSON.stringify(nonce)}});`
      script = await phase('script-create', () =>
        session.createScript(source, { name: 'openlr-startup-control' })
      )
      onMessage = (value, data) => {
        if (value.type === 'send') {
          const payload = value.payload
          marker =
            payload?.fridaStartupControl === 1 &&
            payload.pid === pid &&
            payload.nonce === nonce &&
            data === null
          record({
            event: 'marker',
            valid: marker,
            pid: payload?.pid,
            nonce: payload?.nonce,
            binaryData: data !== null
          })
          received()
        } else {
          scriptErrors = true
          record({
            event: 'script-error',
            type: value.type,
            description: value.description,
            stack: value.stack
          })
        }
      }
      script.message.connect(onMessage)
      await phase('script-load', () => script.load())
      await phase('marker-received', () => within(message, 2000, 'The fixed control marker was not received'))
      assert.equal(marker, true, 'Control marker identity did not match')
    }
  } catch (error) {
    primary = nativeError(error)
    record({ event: 'primary-error', error: primary })
  } finally {
    for (const [name, run] of [
      ['script-unload', script && (() => script.unload())],
      ['message-disconnect', script && onMessage && (() => script.message.disconnect(onMessage))],
      ['session-detach', session && (() => session.detach())],
      ['manager-close', manager && (() => manager.close())]
    ]) {
      if (!run) continue
      try {
        await phase(name, run)
      } catch (error) {
        cleanupErrors.push({ phase: name, error: nativeError(error) })
      }
    }
  }
  const apiCleanupConfirmed =
    !cleanupErrors.length &&
    fulfilled.has('manager-close') &&
    (!session || fulfilled.has('session-detach')) &&
    (!script || fulfilled.has('script-unload'))
  const verified =
    !primary &&
    !scriptErrors &&
    apiCleanupConfirmed &&
    (mode === 'device' || (marker && fulfilled.has('session-detach') && fulfilled.has('script-unload')))
  record({ event: 'result', verified, marker, apiCleanupConfirmed, primary: primary ?? null, cleanupErrors })
  if (!verified) process.exitCode = 1
}

function launch(command, args, stdin = false) {
  const child = spawn(command, args, {
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const output = { stdout: '', stderr: '', truncated: false, closed: null, error: null, stdinError: null }
  const started = performance.now()
  for (const stream of ['stdout', 'stderr'])
    child[stream].setEncoding('utf8').on('data', (chunk) => {
      const limit = 2 * 1024 * 1024
      output.truncated ||= output[stream].length + chunk.length > limit
      output[stream] = (output[stream] + chunk).slice(0, limit)
    })
  child.stdin?.on('error', (error) => (output.stdinError = nativeError(error)))
  child.once('error', (error) => (output.error = nativeError(error)))
  output.completion = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      output.closed = { code, signal, elapsedMs: Math.round(performance.now() - started) }
      resolve(output.closed)
    })
  )
  return { child, output }
}

async function stopOwned(ownedProcess, releaseStdin = false) {
  const { child, output } = ownedProcess
  if (output.closed) return
  if (releaseStdin) {
    child.stdin.end('\n')
    try {
      await within(output.completion, 2000, 'Control stdin release did not end the process')
      return
    } catch {}
  }
  child.kill('SIGTERM')
  try {
    await within(output.completion, 2000, 'Owned process did not exit after SIGTERM')
  } catch {
    child.kill('SIGKILL')
    await within(output.completion, 5000, 'Owned process termination remains unconfirmed')
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'This native startup probe requires macOS')
  assert.equal(process.arch, 'arm64', 'This native startup probe requires ARM64 Node')
  const destination = path.resolve(process.argv[2] || 'build/frida-startup-probe')
  const nonce = randomUUID()
  const directory = path.join(destination, nonce)
  await mkdir(directory, { recursive: true })
  const rea = process.env.OPENLR_REA_CLI
  const selected =
    process.env.OPENLR_FRIDA_BINDING || (rea && createRequire(path.resolve(rea)).resolve('frida'))
  assert.ok(
    selected && path.isAbsolute(selected),
    'Set OPENLR_REA_CLI or OPENLR_FRIDA_BINDING to the provisioned binding'
  )
  let packageDirectory = path.dirname(selected),
    bindingPackage
  for (;;) {
    try {
      const candidate = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
      if (candidate.name === 'frida') {
        bindingPackage = candidate
        break
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(packageDirectory)
    assert.notEqual(parent, packageDirectory, 'Cannot identify the provisioned Frida package')
    packageDirectory = parent
  }
  assert.equal(bindingPackage.version, '17.23.2', 'Use the binding pinned by REA 6.8.0')
  const report = {
    verified: false,
    nonce,
    bindingVersion: bindingPackage.version,
    directory,
    workers: {},
    cleanup: {}
  }
  const owned = []
  let control
  async function save(name, ownedProcess) {
    await writeFile(path.join(directory, name + '.stdout.log'), ownedProcess.output.stdout)
    await writeFile(path.join(directory, name + '.stderr.log'), ownedProcess.output.stderr)
  }
  async function runWorker(mode) {
    const ownedProcess = launch(process.execPath, [
      entry,
      '--worker',
      JSON.stringify({ mode, binding: selected, pid: control?.child.pid, nonce })
    ])
    owned.push([mode, ownedProcess])
    let deadline = false
    try {
      await within(ownedProcess.output.completion, 30_000, 'Frida worker exceeded its parent deadline')
    } catch (error) {
      deadline = true
      report.workers[mode] = { deadline: true, deadlineError: nativeError(error) }
      // Release the independently owned C target before terminating its worker.
      if (control) await stopOwned(control, true)
      if (
        !ownedProcess.output.closed &&
        ownedProcess.child.exitCode === null &&
        ownedProcess.child.signalCode === null &&
        Number.isSafeInteger(ownedProcess.child.pid)
      ) {
        const samplePath = path.join(directory, mode + '.sample.txt')
        const sampler = launch('/usr/bin/sample', [
          String(ownedProcess.child.pid),
          '1',
          '1',
          '-file',
          samplePath
        ])
        owned.push([mode + '-sampler', sampler])
        const observation = { pid: ownedProcess.child.pid, path: samplePath, closed: null }
        report.workers[mode].sample = observation
        try {
          await within(sampler.output.completion, 10_000, 'Owned worker stack sampling exceeded its deadline')
        } catch (error) {
          observation.error = nativeError(error)
          await stopOwned(sampler)
        } finally {
          observation.closed = sampler.output.closed
          observation.truncated = sampler.output.truncated
          await save(mode + '-sampler', sampler)
        }
      }
      await stopOwned(ownedProcess)
    } finally {
      await save(mode, ownedProcess)
      const records = ownedProcess.output.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { event: 'unparsed-output' }
          }
        })
      const result = records.findLast((record) => record.fridaStartup === 1 && record.event === 'result')
      report.workers[mode] = {
        ...report.workers[mode],
        deadline,
        closed: ownedProcess.output.closed,
        error: ownedProcess.output.error,
        truncated: ownedProcess.output.truncated,
        records,
        normalApiCleanupConfirmed: result?.apiCleanupConfirmed === true,
        normalExitConfirmed:
          ownedProcess.output.closed?.code === 0 && ownedProcess.output.closed.signal === null,
        verified:
          !deadline &&
          !ownedProcess.output.truncated &&
          ownedProcess.output.closed?.code === 0 &&
          ownedProcess.output.closed.signal === null &&
          result?.verified === true
      }
    }
    assert.equal(
      report.workers[mode].verified,
      true,
      `${mode} worker did not confirm API cleanup and normal process exit`
    )
  }
  try {
    await runWorker('device')
    const executable = path.join(directory, 'frida-control')
    const compiler = launch('xcrun', [
      'clang',
      '-arch',
      'arm64',
      '-g',
      '-O0',
      '-fno-omit-frame-pointer',
      path.join(path.dirname(entry), 'fixtures', 'frida-control.c'),
      '-o',
      executable
    ])
    owned.push(['compiler', compiler])
    await within(compiler.output.completion, 30_000, 'Control compilation exceeded its deadline')
    await save('compiler', compiler)
    assert.equal(compiler.output.closed.code, 0)
    assert.equal(compiler.output.closed.signal, null)
    control = launch(executable, [], true)
    owned.push(['control-target', control])
    assert.ok(Number.isSafeInteger(control.child.pid) && control.child.pid > 0)
    await within(
      (async () => {
        while (!control.output.stdout.includes(`{"fridaControlReady":${control.child.pid}}\n`)) {
          assert.equal(control.output.closed, null, 'Control exited before readiness')
          await delay(20)
        }
      })(),
      5000,
      'Owned C control did not become ready'
    )
    await runWorker('control')
    control.child.stdin.end('\n')
    await within(control.output.completion, 5000, 'C control did not exit after normal release')
    assert.equal(control.output.closed.code, 0)
    assert.equal(control.output.closed.signal, null)
    assert.equal(control.output.truncated, false)
    report.control = { pid: control.child.pid, closed: control.output.closed }
    report.verified = true
  } catch (error) {
    report.error = nativeError(error)
    process.exitCode = 1
  } finally {
    // The C process goes first on every failure, even if its worker is hung.
    const cleanupOrder = control
      ? [['control-target', control], ...owned.filter(([name]) => name !== 'control-target')]
      : owned
    for (const [name, ownedProcess] of cleanupOrder) {
      try {
        await stopOwned(ownedProcess, name === 'control-target')
        report.cleanup[name] = ownedProcess.output.closed
      } catch (error) {
        report.cleanup[name] = { error: nativeError(error) }
        report.verified = false
        process.exitCode = 1
      }
      await save(name, ownedProcess)
    }
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    await writeFile(path.join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(
      JSON.stringify({
        fridaStartupProbe: report.verified ? 'passed' : 'failed',
        directory,
        error: report.error ?? null
      })
    )
  }
}

if (process.argv[2] === '--worker') await worker(JSON.parse(process.argv[3]))
else await main()
