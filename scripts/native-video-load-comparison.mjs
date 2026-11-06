import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runVideoTrials } from './native-video-trials.mjs'

export { videoTrialOutcome } from './native-video-trials.mjs'
const abbaOrder = (control, candidate) =>
  Array.from({ length: 4 }, () => [control, candidate, candidate, control]).flat()
export const videoLoadOrder = abbaOrder('automatic', 'explicit')
export const videoPauseOrder = abbaOrder('frame-first', 'anchor-first')
export const videoDecoderOrder = abbaOrder('default-decoder', 'software-decoder')

async function main(control, candidate, destination, comparison = 'load') {
  if (!control || !candidate || !destination)
    throw Error('Pass control app, candidate app and report directory')
  const order = new Map([
    ['load', videoLoadOrder],
    ['pause', videoPauseOrder],
    ['decoder', videoDecoderOrder]
  ]).get(comparison)
  if (!order) throw Error('Choose the load, pause or decoder comparison')
  const [controlLabel, candidateLabel] = order
  await runVideoTrials({ apps: { [controlLabel]: control, [candidateLabel]: candidate }, order, destination })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(...process.argv.slice(2))
