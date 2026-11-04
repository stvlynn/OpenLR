export function histogram(canvas) {
  const sample = document.createElement('canvas'),
    scale = Math.min(1, 400 / Math.max(canvas.width, canvas.height))
  sample.width = Math.max(1, Math.round(canvas.width * scale))
  sample.height = Math.max(1, Math.round(canvas.height * scale))
  const ctx = sample.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(canvas, 0, 0, sample.width, sample.height)
  const data = ctx.getImageData(0, 0, sample.width, sample.height).data
  const bins = Array.from({ length: 4 }, () => Array(256).fill(0))
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue
    for (let c = 0; c < 3; c++) bins[c][data[i + c]]++
    bins[3][Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++
  }
  return { red: bins[0], green: bins[1], blue: bins[2], luma: bins[3] }
}
export function drawHistogram(target, bins) {
  const ctx = target.getContext('2d'),
    height = target.height
  ctx.clearRect(0, 0, 256, height)
  ctx.globalCompositeOperation = 'screen'
  const max = Math.max(1, ...bins.red, ...bins.green, ...bins.blue)
  for (const [name, color] of [
    ['red', '#a64d48'],
    ['green', '#509860'],
    ['blue', '#517cad']
  ]) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(0, height)
    bins[name].forEach((v, i) => ctx.lineTo(i, height - (height - 2) * Math.sqrt(v / max)))
    ctx.lineTo(255, height)
    ctx.closePath()
    ctx.fill()
  }
}
export function autoExposure(bins) {
  const total = bins.luma.reduce((a, b) => a + b, 0)
  let count = 0,
    median = 0
  for (; median < 255; median++) {
    count += bins.luma[median]
    if (count >= total * 0.5) break
  }
  const linear = ((Math.max(1, median) / 255 + 0.055) / 1.055) ** 2.4
  return Math.round(Math.max(-5, Math.min(5, Math.log2(0.18 / linear))) * 20) / 20
}
