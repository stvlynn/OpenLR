import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
const server = createServer(async (req, res) => {
  try {
    const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'web/index.html'
    if (file.includes('..')) throw Error()
    res.setHeader(
      'Content-Type',
      /\.m?js$/.test(file)
        ? 'text/javascript'
        : file.endsWith('.wasm')
          ? 'application/wasm'
          : file.endsWith('.html')
            ? 'text/html'
            : 'application/octet-stream'
    )
    res.end(await readFile(file))
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', headless: true })
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port + '/web/index.html')
  const result = await page.evaluate(async () => {
    const { processEnhance } = await import('./enhance-kernel.js'),
      bitmap = await createImageBitmap(await (await fetch('/tests/fixtures/ai/astronaut.png')).blob()),
      canvas = document.createElement('canvas')
    canvas.width = canvas.height = 192
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bitmap, 160, 40, 192, 192, 0, 0, 192, 192)
    bitmap.close()
    const clean = ctx.getImageData(0, 0, 192, 192),
      noisy = { width: 192, height: 192, data: clean.data.slice() }
    let seed = 42
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296
    for (let i = 0; i < noisy.data.length; i++)
      if (i % 4 !== 3)
        noisy.data[i] += 15 * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())
    const score = (a, b) => {
      let error = 0,
        n = 0
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) {
          error += (a[i] - b[i]) ** 2
          n++
        }
      return { mse: error / n, psnr: 10 * Math.log10(255 ** 2 / (error / n)) }
    }
    const records = [],
      denoised = []
    for (const [transfer, tileSize] of [
      ['linear', 256],
      ['none', 256],
      ['linear', 64]
    ]) {
      const output = await processEnhance({
        pixels: noisy,
        mode: 'denoise',
        modelUrl: '/.tools/ai-models/oidn-rt-ldr-small.onnx',
        transfer,
        tileSize
      })
      records.push({
        mode: 'denoise',
        transfer,
        tileSize,
        metrics: output.metrics,
        score: score(clean.data, output.data)
      })
      denoised.push(output)
    }
    const low = document.createElement('canvas')
    low.width = low.height = 64
    low.getContext('2d').drawImage(canvas, 0, 0, 64, 64)
    const small = low.getContext('2d').getImageData(0, 0, 64, 64),
      up = document.createElement('canvas')
    up.width = up.height = 192
    const u = up.getContext('2d', { willReadFrequently: true })
    u.imageSmoothingQuality = 'low'
    u.drawImage(low, 0, 0, 192, 192)
    const baseline = u.getImageData(0, 0, 192, 192),
      superres = await processEnhance({
        pixels: small,
        mode: 'super-resolution',
        modelUrl: '/.tools/ai-models/espcn-x3.onnx'
      })
    records.push(
      { mode: 'noisy-input', sigma: 15, seed: 42, score: score(clean.data, noisy.data) },
      {
        mode: 'tiling-ablation',
        comparison: '64 core vs 256 core; 64 halo',
        difference: score(denoised[0].data, denoised[2].data)
      },
      { mode: 'bilinear-x3', score: score(clean.data, baseline.data) },
      { mode: 'espcn-x3', metrics: superres.metrics, score: score(clean.data, superres.data) }
    )
    const figure = document.createElement('canvas')
    figure.width = 768
    figure.height = 512
    const fig = figure.getContext('2d')
    fig.fillStyle = '#181818'
    fig.fillRect(0, 0, 768, 512)
    for (const [index, [label, pixels]] of [
      ['Public-domain NASA crop', clean],
      ['Gaussian noise sigma 15', noisy],
      ['OIDN / linear input', denoised[0]],
      ['OIDN / omit transfer', denoised[1]],
      ['Bilinear x3', baseline],
      ['ESPCN x3', superres]
    ].entries()) {
      const image = document.createElement('canvas')
      image.width = pixels.width
      image.height = pixels.height
      image.getContext('2d').putImageData(new ImageData(pixels.data, pixels.width, pixels.height), 0, 0)
      const x = (index % 3) * 256,
        y = Math.floor(index / 3) * 256
      fig.drawImage(image, x + 8, y + 36, 240, 216)
      fig.fillStyle = '#eee'
      fig.font = '14px sans-serif'
      fig.fillText(label, x + 8, y + 20)
    }
    return { records, userAgent: navigator.userAgent, image: figure.toDataURL().split(',')[1] }
  })
  await writeFile('research/enhance/qualitative.png', Buffer.from(result.image, 'base64'))
  delete result.image
  await writeFile('research/enhance/benchmark.json', JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
  server.closeAllConnections()
  server.close()
}
