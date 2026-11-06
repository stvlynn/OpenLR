import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parse, execute, watch } from '../cli/openlr.mjs'

test('selection guards validate photo IDs during offline command preview', async () => {
  for (const args of [
    ['rate', '--value', '3'],
    ['flag', '--value', 'pick'],
    ['keywords', '--value', 'ridge'],
    ['label', '--value', 'red'],
    ['capture-time', '--time', '2024-06-12T15:30:00.000Z'],
    ['membership', '--album', 'album'],
    ['delete'],
    ['restore'],
    ['paste-edits'],
    ['stack'],
    ['cull'],
    ['purge']
  ]) {
    assert.throws(
      () => parse([...args, '--expectedIds', '[1]', '--dry-run']),
      /expectedIds must contain photo IDs/
    )
    const result = await execute(parse([...args, '--expectedIds', '["b","a"]', '--dry-run']))
    assert.deepEqual(result.request.args.expectedIds, ['b', 'a'])
  }
})

test('offline discovery and dry runs validate real command arguments', async () => {
  assert.equal(
    (
      await execute(
        parse([
          'share-configure',
          '--endpoint',
          'http://127.0.0.1:8788',
          '--token',
          'private-admin-token',
          '--dry-run'
        ])
      )
    ).request.args.token,
    '[redacted]'
  )
  for (const name of ['open', 'watch']) {
    assert.equal(parse(['cli', 'search', name]).local[0].command, name)
    assert.deepEqual(parse(['schema', name]).local, parse([name, '-h']).local)
  }
  assert.deepEqual(parse(['import', '--', '--help', '-h']).args.files, ['--help', '-h'])
  assert.equal(parse(['open', '--app', '--help']).app, '--help')
  assert.ok(parse(['cli', 'search', 'exposure']).local.some((result) => result.command === 'edit'))
  assert.equal(parse(['schema', 'export']).local.parameters.properties.format.enum[1], 'image/png')
  assert.equal(parse(['export-previous', '--dry-run']).command, 'export-previous')
  assert.ok(
    parse(['cli', 'search', 'previous export']).local.some((result) => result.command === 'export-previous')
  )
  assert.throws(() => parse(['export-previous', '--format', 'image/png']), /Unknown option/)
  assert.throws(() => parse(['export-settings', '--media', 'photo']), /together|both/i)
  assert.deepEqual(
    (await execute(parse(['edit', '--key', 'Exposure', '--value', '0.5', '--dry-run']))).request,
    { command: 'edit', args: { key: 'Exposure', value: 0.5 } }
  )
  assert.equal(parse(['edit', '--key', 'aspect', '--value', '1.5', '--dry-run']).args.value, '1.5')
  assert.equal(parse(['edit', '--key', 'flip', '--value', 'true']).args.value, true)
  assert.throws(() => parse(['rate', '--value', '2.5']), /integer/)
  assert.throws(() => parse(['edit', '--key', 'Exposure', '--value', '6']), /between/)
  assert.throws(() => parse(['select']), /Missing argument/)
  assert.throws(() => parse(['state', '--unexpected', 'true']), /Unknown option/)
})

test('watch observes only read-only state or export progress and preserves null/results/capture', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openlr-export-watch-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const requests = [],
    image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  let revision = 0,
    current = null
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer observer')
    res.setHeader('Content-Type', 'application/json')
    if (req.url.startsWith('/changes?')) {
      res.end(JSON.stringify({ revision: revision++ }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks))
    requests.push(request)
    res.end(
      JSON.stringify({
        ok: true,
        result: request.command === 'state' ? { selected: 'photo' } : current,
        ...(request.capture
          ? {
              selected: 'photo',
              frame: {
                kind: 'file',
                filename: 'workspace.png',
                mimeType: 'image/png',
                bytes: image.length,
                base64: image.toString('base64')
              }
            }
          : {})
      })
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const session = path.join(directory, 'agent.json')
  await writeFile(
    session,
    JSON.stringify({ version: 1, url: 'http://127.0.0.1:' + server.address().port, token: 'observer' })
  )
  const updates = [],
    base = ['watch', '--session', session, '--count', '1']
  assert.throws(() => parse([...base, '--command', 'edit']), /state or export-status/)
  assert.equal(parse([...base, '--command', 'export-status']).command, 'watch')
  await watch(parse(base), (value) => updates.push(value))
  assert.equal(updates.at(-1).selected, 'photo')
  assert.deepEqual(requests.at(-1).args, { summary: true })
  await watch(parse([...base, '--command', 'export-status']), (value) => updates.push(value))
  assert.deepEqual(updates.at(-1), { revision: 1, result: null })
  assert.equal(requests.at(-1).command, 'export-status')
  assert.deepEqual(requests.at(-1).args, {})
  current = { id: 'job-1', status: 'running', completed: 1, total: 3 }
  await watch(
    parse([...base, '--command', 'export-status', '--images', path.join(directory, 'frames')]),
    (value) => updates.push(value)
  )
  assert.deepEqual(updates.at(-1).result, current)
  assert.deepEqual(await readFile(updates.at(-1).frame.path), image)
  assert.equal(updates.at(-1).selected, 'photo')
})

test('batch CLI passes one folder request and preserves exact partial-completion errors', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openlr-batch-transport-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const requests = [],
    files = [{ id: 'one', path: path.join(directory, 'one.png'), filename: 'one.png', bytes: 123 }],
    image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  let fail = false
  const details = { completed: 1, total: 3, failed: { id: 'two', name: 'two.png' }, files }
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks)))
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify(
        fail
          ? { ok: false, error: { message: 'Destination full', details } }
          : {
              ok: true,
              result: { files, total: 1, cancelled: false },
              ...(requests.at(-1).capture
                ? {
                    selected: 'one',
                    frame: {
                      kind: 'file',
                      filename: 'workspace.png',
                      mimeType: 'image/png',
                      bytes: image.length,
                      base64: image.toString('base64')
                    }
                  }
                : {})
            }
      )
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const session = path.join(directory, 'agent.json')
  await writeFile(
    session,
    JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port, token: 'test', version: 1 })
  )
  const args = ['export-selection', '--format', 'image/png', '--output-dir', directory, '--session', session]
  const dry = await execute(parse([...args, '--dry-run']))
  assert.equal(dry.request.args.outputDirectory, directory)
  assert.equal(requests.length, 0)
  assert.deepEqual(await execute(parse(args)), { files, total: 1, cancelled: false })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].args.outputDirectory, directory)
  const capturePath = path.join(directory, 'workspace.png')
  const captured = await execute(parse([...args, '--capture', capturePath]))
  assert.deepEqual(captured.result, { files, total: 1, cancelled: false })
  assert.equal(captured.selected, 'one')
  assert.equal(captured.frame.path, capturePath)
  assert.deepEqual(await readFile(capturePath), image)
  assert.equal(requests.at(-1).capture, true)
  assert.throws(() => parse([...args, '--force']), /numbered filenames/)
  assert.throws(() => parse([...args, '--output', 'one.png']), /numbered filenames/)
  assert.throws(() => parse(['export', '--output-dir', directory]), /requires export-selection/)
  fail = true
  await assert.rejects(execute(parse(args)), (error) => {
    assert.equal(error.message, 'Destination full')
    assert.deepEqual(error.details, details)
    return true
  })
  const failed = await childScript(
    `import { main } from ${JSON.stringify(new URL('../cli/openlr.mjs', import.meta.url).href)}; await main(${JSON.stringify(args)});`
  )
  assert.equal(failed.code, 1)
  assert.deepEqual(JSON.parse(failed.stderr).error.details, details)
  assert.equal(failed.stdout.length, 0)
  assert.ok(requests.every((request) => request.command === 'export-selection'))
})

test('CLI uses the authenticated live transport, moves file bytes, and protects outputs', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openlr-agent-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const received = []
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/command')
    assert.equal(req.headers.authorization, 'Bearer test-session-token')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks))
    received.push(request)
    let result
    if (request.command === 'preview')
      result = {
        kind: 'file',
        filename: 'current.png',
        mimeType: 'image/png',
        bytes: image.length,
        base64: image.toString('base64')
      }
    else result = { selected: 'live-photo', photos: [], imported: request.args.files?.length }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const session = path.join(directory, 'agent.json')
  await writeFile(
    session,
    JSON.stringify({
      url: 'http://127.0.0.1:' + server.address().port,
      token: 'test-session-token',
      version: 1,
      pid: process.pid
    })
  )
  const state = await execute(parse(['state', '--session', session]))
  assert.equal(state.selected, 'live-photo')
  const input = path.join(directory, 'source.png')
  await writeFile(input, image)
  const imported = await execute(parse(['import', input, '--session', session]))
  assert.equal(imported.imported, 1)
  assert.equal(received[1].args.files[0].base64, image.toString('base64'))
  assert.equal(received[1].args.files[0].type, 'image/png')
  const mediaTypes = {
    'source.WEBM': 'video/webm',
    'source.mov': 'video/quicktime',
    'source.mp4': 'video/mp4',
    'source.m4v': 'video/mp4',
    'source.mkv': 'video/matroska',
    'source.unknown': 'application/octet-stream'
  }
  const mediaFiles = Object.keys(mediaTypes).map((name) => path.join(directory, name))
  for (const file of mediaFiles) await writeFile(file, path.basename(file))
  const videoImport = await execute(parse(['import', ...mediaFiles, '--session', session]))
  assert.equal(videoImport.imported, mediaFiles.length)
  assert.deepEqual(
    received
      .at(-1)
      .args.files.map(({ name, type, base64 }) => [name, type, Buffer.from(base64, 'base64').toString()]),
    Object.entries(mediaTypes).map(([name, type]) => [name, type, name])
  )
  const catalog = path.join(directory, 'synthetic.lrcat')
  await writeFile(catalog, Buffer.from('SQLite format 3\0synthetic transport fixture'))
  await execute(parse(['migration-scan', '--catalog', catalog, '--session', session]))
  assert.equal(received.at(-1).args.catalog.name, 'synthetic.lrcat')
  assert.deepEqual(Buffer.from(received.at(-1).args.catalog.base64, 'base64'), await readFile(catalog))
  const output = path.join(directory, 'preview.png')
  const previewRequest = parse(['preview', '--output', output, '--session', session])
  assert.equal((await execute(previewRequest)).path, output)
  assert.deepEqual(await readFile(output), image)
  await assert.rejects(execute(previewRequest), /EEXIST/)
  await execute({ ...previewRequest, force: true })
})

test('transport failures remain failures, without inventing local GUI state', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openlr-agent-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const session = path.join(directory, 'agent.json')
  await writeFile(session, JSON.stringify({ url: 'https://example.com', token: 'test', version: 1 }))
  await assert.rejects(execute(parse(['state', '--session', session])), /Invalid local/)
  await assert.rejects(
    execute(parse(['state', '--session', path.join(directory, 'missing.json')])),
    /Start OpenLR first/
  )
})

async function exportSession(t, behavior = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openlr-export-completion-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    settings = { media: 'photo', options: { format: 'image/png', colorSpace: 'display-p3', quality: 0.92 } },
    requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks))
    requests.push(request)
    res.setHeader('Content-Type', 'application/json')
    if (request.command === 'export-settings') {
      try {
        await behavior.onAcknowledge?.(request)
        if (behavior.failAcknowledgment) throw Error('Settings store unavailable')
        res.end(JSON.stringify({ ok: true, result: { photo: settings.options, video: null } }))
      } catch (error) {
        res.end(JSON.stringify({ ok: false, error: { message: error.message } }))
      }
    } else {
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            kind: 'file',
            filename: 'completed.png',
            mimeType: 'image/png',
            bytes: image.length + (behavior.incomplete ? 1 : 0),
            base64: image.toString('base64'),
            exportSettings: settings
          }
        })
      )
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const session = path.join(directory, 'agent.json')
  await writeFile(
    session,
    JSON.stringify({
      url: 'http://127.0.0.1:' + server.address().port,
      token: 'export-test-session',
      version: 1
    })
  )
  return { directory, session, image, settings, requests }
}

test('CLI remembers the resolved export snapshot only after a successful output write', async (t) => {
  const behavior = {},
    { directory, session, image, settings, requests } = await exportSession(t, behavior),
    output = path.join(directory, 'completed.png')
  behavior.onAcknowledge = async () => assert.deepEqual(await readFile(output), image)
  const request = parse(['export', '--format', 'image/png', '--output', output, '--session', session])
  assert.equal((await execute(request)).path, output)
  assert.deepEqual(
    requests.map((entry) => entry.command),
    ['export', 'export-settings']
  )
  assert.deepEqual(requests.at(-1).args, settings)
  assert.notDeepEqual(request.args, settings.options)
  await assert.rejects(execute(request), /EEXIST/)
  assert.equal(requests.filter((entry) => entry.command === 'export-settings').length, 1)
  await execute({ ...request, force: true })
  assert.equal(requests.filter((entry) => entry.command === 'export-settings').length, 2)
  await assert.rejects(
    execute({ ...request, output: path.join(directory, 'missing', 'failed.png') }),
    /ENOENT/
  )
  behavior.incomplete = true
  await assert.rejects(
    execute({ ...request, output: path.join(directory, 'incomplete.png') }),
    /Incomplete image/
  )
  behavior.incomplete = false
  assert.equal(requests.filter((entry) => entry.command === 'export-settings').length, 2)
  await execute(parse(['preview', '--output', path.join(directory, 'preview.png'), '--session', session]))
  assert.equal(requests.filter((entry) => entry.command === 'export-settings').length, 2)
  await execute(parse(['export-previous', '--output', output, '--force', '--session', session]))
  assert.equal(requests.filter((entry) => entry.command === 'export-settings').length, 3)
  behavior.onAcknowledge = undefined
  const generated = await execute(parse(['export', '--session', session]))
  t.after(() => rm(generated.path, { force: true }))
  assert.deepEqual(await readFile(generated.path), image)
  assert.equal(requests.filter((entry) => entry.command === 'export-settings').length, 4)
})

test('CLI acknowledgment failure reports the completed file and never rewrites it', async (t) => {
  const { directory, session, image, requests } = await exportSession(t, { failAcknowledgment: true }),
    output = path.join(directory, 'saved.png')
  await assert.rejects(
    execute(parse(['export', '--output', output, '--session', session])),
    (error) =>
      error.message.includes('File was saved to ' + output) &&
      /export settings could not be remembered: Settings store unavailable/.test(error.message)
  )
  assert.deepEqual(await readFile(output), image)
  assert.deepEqual(
    requests.map((entry) => entry.command),
    ['export', 'export-settings']
  )
})

function childScript(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
        stdio: ['ignore', 'pipe', 'pipe']
      }),
      stdout = [],
      stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) =>
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() })
    )
  })
}

test('CLI stdout export awaits stream completion before remembering settings', async (t) => {
  const behavior = {},
    { directory, session, image, requests } = await exportSession(t, behavior),
    marker = path.join(directory, 'stdout-finished')
  behavior.onAcknowledge = async () => assert.equal(await readFile(marker, 'utf8'), 'finished')
  const result = await childScript(`
    import { execute, parse } from ${JSON.stringify(new URL('../cli/openlr.mjs', import.meta.url).href)};
    import { writeFile } from 'node:fs/promises';
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (bytes, callback) => original(bytes, () => {
      setTimeout(async () => {
        await writeFile(${JSON.stringify(marker)}, 'finished');
        callback();
      }, 30);
    });
    await execute(parse(${JSON.stringify(['export', '--output', '-', '--session', session])}));
  `)
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.stdout, image)
  assert.deepEqual(
    requests.map((entry) => entry.command),
    ['export', 'export-settings']
  )
})

test('failed stdout writes do not remember an export, and acknowledgment errors report stdout completion', async (t) => {
  const behavior = {},
    { session, image, requests } = await exportSession(t, behavior),
    invocation = `await execute(parse(${JSON.stringify(['export', '--output', '-', '--session', session])}));`
  const failed = await childScript(`
    import { execute, parse } from ${JSON.stringify(new URL('../cli/openlr.mjs', import.meta.url).href)};
    process.stdout.write = (_bytes, callback) => {
      queueMicrotask(() => {
        const error = Error('Simulated stdout failure');
        callback(error);
        process.stdout.emit('error', error);
      });
      return true;
    };
    try { ${invocation} }
    catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
  `)
  assert.equal(failed.code, 1)
  assert.match(failed.stderr, /Simulated stdout failure/)
  assert.equal(failed.stdout.length, 0)
  assert.deepEqual(
    requests.map((entry) => entry.command),
    ['export']
  )
  behavior.failAcknowledgment = true
  const saved = await childScript(`
    import { execute, parse } from ${JSON.stringify(new URL('../cli/openlr.mjs', import.meta.url).href)};
    try { ${invocation} }
    catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
  `)
  assert.equal(saved.code, 1)
  assert.deepEqual(saved.stdout, image)
  assert.match(
    saved.stderr,
    /Export bytes were written to stdout, but export settings could not be remembered/
  )
  assert.deepEqual(
    requests.map((entry) => entry.command),
    ['export', 'export', 'export-settings']
  )
})
