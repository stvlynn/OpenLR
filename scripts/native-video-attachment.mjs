import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { runVideoTrials } from './native-video-trials.mjs'

const [mode, detached, connected, destination] = process.argv.slice(2)

if (mode === 'apply') {
  const changes = {
    'web/app.js': [
      [
        'media = await openVideo(data.file, undefined, seekTrace)',
        'media = await openVideo(data.file, undefined, seekTrace, false, true)'
      ]
    ],
    'web/video.js': [
      ['seekTrace, preparePoster = false)', 'seekTrace, preparePoster = false, connect = false)'],
      ['    video.load()\n    URL.revokeObjectURL(url)', '    video.load()\n    if (connect) video.remove()\n    URL.revokeObjectURL(url)'],
      [
        "    markVideoSeek(seekTrace, 'playback-load', video)",
        `    if (connect) {
      video.hidden = true
      document.body.append(video)
      markVideoSeek(seekTrace, 'playback-connected')
    }
    markVideoSeek(seekTrace, 'playback-load', video)`
      ]
    ]
  }
  const modified = []
  for (const [file, pairs] of Object.entries(changes)) {
    let source = await readFile(file, 'utf8')
    for (const [before, after] of pairs) {
      assert.equal(source.split(before).length, 2, `Expected one source marker in ${file}: ${before}`)
      source = source.replace(before, after)
    }
    modified.push([file, source])
  }
  for (const [file, source] of modified) await writeFile(file, source)
} else {
  assert.ok(mode === 'compare' && detached && connected && destination, 'Pass compare and both apps and report directory')
  const pair = ['detached', 'connected', 'connected', 'detached']
  const order = [...pair, ...pair.toReversed(), ...pair, ...pair.toReversed()]
  await runVideoTrials({ apps: { detached, connected }, order, destination })
}
