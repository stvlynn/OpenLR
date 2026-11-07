const requiredText = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new TypeError(`${name} must be a nonempty string without NUL`)
  return value
}

// This builder performs no attachment or target execution. REA owns that lifecycle.
export function buildFridaSignalObserver({
  ownedPid,
  nonce,
  moduleName,
  expectedUUID,
  targetOffset,
  readyPath,
  capturePath
}) {
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0) throw new TypeError('ownedPid must be positive')
  requiredText(nonce, 'nonce')
  requiredText(moduleName, 'moduleName')
  requiredText(expectedUUID, 'expectedUUID')
  requiredText(readyPath, 'readyPath')
  requiredText(capturePath, 'capturePath')
  if (nonce.length > 128 || moduleName.length > 256 || /[/\\]/.test(moduleName))
    throw new TypeError('Use a bounded nonce and module basename')
  if (!/^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.test(expectedUUID))
    throw new TypeError('expectedUUID must be a Mach-O UUID')
  if (!(
    (typeof targetOffset === 'number' && Number.isSafeInteger(targetOffset) && targetOffset >= 0) ||
    (typeof targetOffset === 'string' && /^(?:0x[\da-f]+|\d+)$/i.test(targetOffset))
  ))
    throw new TypeError('targetOffset must be a nonnegative integer or integer string')
  const offset = BigInt(targetOffset)
  if (offset >= 1n << 64n || offset % 4n !== 0n)
    throw new TypeError('targetOffset must be an aligned 64-bit offset')
  if (readyPath === capturePath) throw new TypeError('Ready and capture paths must differ')
  const options = {
    ownedPid,
    nonce,
    moduleName,
    expectedUUID: expectedUUID.replaceAll('-', '').toLowerCase(),
    targetOffset: '0x' + offset.toString(16),
    readyPath,
    capturePath
  }
  return `(${signalObserver.toString()})(${JSON.stringify(options)});\n`
}

function signalObserver(options) {
  const scope = {
    nativeSignalObserver: 1,
    nonce: options.nonce,
    pid: Process.id,
    frida: { version: Frida.version, runtime: Script.runtime }
  }
  let captured = false,
    captureWritten = false,
    ready = false,
    handlerInstalled = false,
    target = null,
    observer = null
  const diagnostic = (stage, error) => ({
    stage,
    error: typeof error?.name === 'string' ? error.name : 'Error',
    reason: typeof error?.observerReason === 'string' ? error.observerReason : 'api-failure'
  })
  const reject = (reason) => {
    const error = new Error(reason)
    error.observerReason = reason
    throw error
  }
  const publish = (path, event) => {
    const record = { ...scope, ...event }
    const text = JSON.stringify(record)
    // At most 16,384 UTF-16 units, hence at most 49,152 UTF-8 bytes.
    if (text.length > 16_384) reject('record-size-limit')
    File.writeAllText(path, text + '\n')
    if (path === options.capturePath) captureWritten = true
    send(record)
  }
  const reportError = (stage, error) => {
    const event = { kind: 'error', ...diagnostic(stage, error) }
    try {
      captured = true
      if (!captureWritten) {
        publish(options.capturePath, event)
      } else send({ ...scope, ...event })
    } catch (publicationError) {
      // The REA message channel still reports a failed sidecar write.
      const failure = {
        ...scope,
        kind: 'error',
        ...diagnostic('publish-error', publicationError),
        cause: event
      }
      try {
        send(failure)
      } catch {
        // Forward the original fault even when both observation channels failed.
        try {
          console.error(JSON.stringify(failure))
        } catch {}
      }
    }
  }
  try {
    if (Process.id !== options.ownedPid) reject('owned-pid-mismatch')
    if (Process.platform !== 'darwin' || Process.arch !== 'arm64') reject('unsupported-target')
    const moduleMap = new ModuleMap()
    const modules = new Map()
    const basename = (name) => name.split(/[/\\]/).pop().slice(0, 256)
    const metadata = (module) => {
      const base = module.base
      if (module.size < 32 || base.readU32() !== 0xfeedfacf) reject('invalid-mach-o64')
      const count = base.add(16).readU32(),
        bytes = base.add(20).readU32()
      if (count > 8192 || bytes > 1_048_576 || bytes > module.size - 32) reject('invalid-load-commands')
      let cursor = 32,
        uuid = null
      for (let index = 0; index < count; index++) {
        if (cursor + 8 > 32 + bytes) reject('truncated-load-command')
        const command = base.add(cursor),
          kind = command.readU32(),
          size = command.add(4).readU32()
        if (size < 8 || size % 4 !== 0 || cursor + size > 32 + bytes) reject('invalid-load-command-size')
        if (kind === 0x1b) {
          if (size !== 24 || uuid !== null) reject('invalid-lc-uuid')
          uuid = ''
          for (let byte = 0; byte < 16; byte++)
            uuid += command
              .add(8 + byte)
              .readU8()
              .toString(16)
              .padStart(2, '0')
        }
        cursor += size
      }
      if (!uuid) reject('missing-lc-uuid')
      return { module: basename(module.name), uuid, base: base.toString() }
    }
    const frame = (address) => {
      const stripped = address.strip(),
        module = moduleMap.find(stripped),
        identity = module && modules.get(module.base.toString()),
        addresses = { address: stripped.toString(), rawAddress: address.toString() }
      return identity
        ? { ...addresses, ...identity, offset: stripped.sub(module.base).toString() }
        : { ...addresses, module: null, uuid: null, base: null, offset: null }
    }
    const maybeReady = () => {
      if (!handlerInstalled || !observer || !target || ready || captured) return
      ready = true
      publish(options.readyPath, { kind: 'ready', target: target.identity })
    }
    Process.setExceptionHandler((details) => {
      try {
        if (
          captured ||
          !ready ||
          !target ||
          details.type !== 'breakpoint' ||
          !details.context.pc.equals(target.address)
        )
          return false
        const module = moduleMap.find(details.context.pc),
          identity = module && modules.get(module.base.toString())
        if (
          !identity ||
          identity.uuid !== options.expectedUUID ||
          identity.base !== target.identity.base ||
          details.context.pc.sub(module.base).toString() !== options.targetOffset
        )
          return false
        captured = true
        const registers = {}
        for (const name of [
          'pc',
          'lr',
          'fp',
          'sp',
          'x0',
          'x1',
          'x2',
          'x3',
          'x19',
          'x20',
          'x21',
          'x22',
          'x23',
          'x24'
        ])
          registers[name] = details.context[name].toString()
        const frames = Thread.backtrace(details.context, Backtracer.ACCURATE).slice(0, 16).map(frame)
        publish(options.capturePath, {
          kind: 'capture',
          type: details.type,
          target: target.identity,
          registers,
          backtracer: 'accurate',
          frames
        })
      } catch (error) {
        reportError('exception-handler', error)
      }
      // Preserve the original context and forward the exception to its host handler.
      return false
    })
    handlerInstalled = true
    observer = Process.attachModuleObserver({
      onAdded(module) {
        try {
          moduleMap.update()
          const identity = metadata(module)
          modules.set(module.base.toString(), identity)
          if (identity.module !== options.moduleName) return
          if (identity.uuid !== options.expectedUUID) reject('target-uuid-mismatch')
          const address = module.base.add(options.targetOffset)
          if (address.compare(module.base) < 0 || address.add(4).compare(module.base.add(module.size)) > 0)
            reject('target-offset-outside-module')
          const word = address.readU32()
          if ((word & 0xffe0001f) >>> 0 !== 0xd4200000) reject('target-is-not-brk')
          target = {
            address,
            identity: {
              ...identity,
              offset: options.targetOffset,
              instructionWord: '0x' + word.toString(16).padStart(8, '0')
            }
          }
          maybeReady()
        } catch (error) {
          if (basename(module.name) === options.moduleName) reportError('target-module', error)
          else
            send({
              ...scope,
              kind: 'module-error',
              module: basename(module.name),
              ...diagnostic('module-metadata', error)
            })
        }
      },
      onRemoved(module) {
        modules.delete(module.base.toString())
        moduleMap.update()
        if (target && target.identity.base === module.base.toString()) {
          target = null
          reportError('target-module', { observerReason: 'target-module-unloaded' })
        }
      }
    })
    // Readiness retains the observer and waits for its initial module callbacks.
    // REA script unload owns release of the handler and observer.
    maybeReady()
  } catch (error) {
    reportError('observer-startup', error)
  }
}
