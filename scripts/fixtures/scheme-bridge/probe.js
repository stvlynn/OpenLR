const call = (name, ...args) => window.mygo.call(`SchemeProbe.${name}`, ...args)
const endpoint = 'mygo://localhost/__openlr_bridge'
const originalFetch = window.fetch.bind(window)
window.fetch = async (url, options) => {
  if (String(url) === endpoint && typeof options?.body === 'string') {
    let envelope
    try {
      envelope = JSON.parse(options.body)
    } catch {}
    if (envelope?.kind === 'message') window.__capturedEnvelope ||= options.body
    if (envelope?.kind === 'eval' && window.__duplicateNextEval) {
      window.__duplicateNextEval = false
      const response = await originalFetch(url, options)
      window.__duplicateStatus = (await originalFetch(url, options)).status
      return response
    }
  }
  return originalFetch(url, options)
}

async function firstPage() {
  const checks = {}
  const text = '漢字🌍λ\u0000"\\\n'.repeat(200000)
  checks.unicodeLargeExact = (await call('Echo', text)) === text
  const inputs = Array.from({ length: 40 }, (_, index) => `${index}:λ`)
  checks.concurrentCalls =
    JSON.stringify(await Promise.all(inputs.map((text) => call('Echo', text)))) === JSON.stringify(inputs)
  const event = new Promise((resolve) => mygo.once('scheme-probe:progress', resolve))
  await call('Event')
  checks.eventUnicode = (await event) === 'event:漢字🌍\u0000'
  const channel = mygo.channel()
  const streamDone = call('Stream', channel)
  const values = []
  for await (const value of channel) values.push(value)
  await streamDone
  checks.channelOrderAndBackpressure =
    values.length === 24 && values.every((value, index) => value === `${index}:` + 'λ'.repeat(65536))
  checks.nativeScriptMessageHandlerAbsent =
    !window.webkit?.messageHandlers?.mygo && !window.webkit?.messageHandlers?.mygoPictureInPicture
  checks.getRejected = (await fetch(endpoint)).status === 405
  checks.forgedCapabilityRejected =
    (
      await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ document: 'forged', kind: 'message', message: 'forged' })
      })
    ).status === 403
  const controller = new AbortController()
  const aborted = fetch(endpoint, { method: 'POST', body: '{}', signal: controller.signal })
  controller.abort()
  checks.abortedFetch = await aborted.then(
    () => false,
    (error) => error.name === 'AbortError'
  )
  const childResult = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error('child frame did not answer')), 8000)
    addEventListener('message', function receive(event) {
      if (!event.data?.schemeChild) return
      removeEventListener('message', receive)
      clearTimeout(deadline)
      resolve(event.data)
    })
  })
  const frame = document.createElement('iframe')
  frame.src = '/child.html'
  document.body.append(frame)
  const child = await childResult
  checks.childHasNoBridge = child.bridgeAbsent
  checks.childForgeryRejected = child.status === 403
  frame.remove()
  await call('RendererChecks', checks)
  await call('Ready', 'first')
}

try {
  if (new URLSearchParams(location.search).get('phase') === 'second') await call('Ready', 'second')
  else await firstPage()
  document.querySelector('#status').textContent =
    'Renderer checks submitted; native Eval and navigation checks are running'
} catch (error) {
  document.querySelector('#status').textContent = String(error.stack || error)
  await call('RendererError', String(error.stack || error))
}
