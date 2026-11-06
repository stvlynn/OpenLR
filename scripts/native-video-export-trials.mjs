import { runVideoTrials } from './native-video-trials.mjs'

const [app, destination, mode] = process.argv.slice(2)
if (!app || !destination || (mode !== undefined && mode !== '--lldb'))
  throw Error('Pass app, report directory and optional --lldb')
const candidate = mode ? 'debugger' : 'ordinary'
await runVideoTrials({
  apps: { [candidate]: app },
  order: Array(8).fill(candidate),
  destination,
  args: mode ? [mode] : []
})
