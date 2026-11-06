import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runVideoTrials } from './native-video-trials.mjs'

export { videoTrialOutcome } from './native-video-trials.mjs'
export const videoLoadOrder = Array.from({ length: 4 }, () => [
  'automatic',
  'explicit',
  'explicit',
  'automatic'
]).flat()

async function main(automatic, explicit, destination) {
  if (!automatic || !explicit || !destination)
    throw Error('Pass automatic app, explicit-load app and report directory')
  await runVideoTrials({ apps: { automatic, explicit }, order: videoLoadOrder, destination })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(...process.argv.slice(2))
