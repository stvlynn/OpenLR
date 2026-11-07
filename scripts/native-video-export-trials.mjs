import { runVideoTrials } from './native-video-trials.mjs'

const [app, destination, mode] = process.argv.slice(2)
if (
  !app ||
  !destination ||
  (mode !== undefined && !['--lldb', '--lldb-workflow', '--compare-audio-trace'].includes(mode))
)
  throw Error('Pass app, report directory and optional --lldb, --lldb-workflow or --compare-audio-trace')
const compareAudioTrace = mode === '--compare-audio-trace'
const candidate = mode === '--lldb-workflow' ? 'workflow-debugger' : mode ? 'debugger' : 'ordinary'
await runVideoTrials({
  apps: compareAudioTrace ? { quiet: app, traced: app } : { [candidate]: app },
  order: compareAudioTrace
    ? Array.from({ length: 4 }, () => ['quiet', 'traced', 'traced', 'quiet']).flat()
    : Array(24).fill(candidate),
  environments: compareAudioTrace
    ? { quiet: { OPENLR_AUDIO_DIAGNOSTICS: '0' }, traced: { OPENLR_AUDIO_DIAGNOSTICS: '1' } }
    : {},
  destination,
  args: mode && !compareAudioTrace ? [mode] : []
})
