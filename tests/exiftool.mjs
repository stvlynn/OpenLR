import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Optional independent validation tool, never an application dependency.
const script = fileURLToPath(
  new URL('../.tools/exiftool-980409314fddbd83d9092b5c160fafab7f67fd52/exiftool', import.meta.url)
)
const linuxPath = (file) =>
  path
    .resolve(file)
    .replace(/^([A-Za-z]):/, (_, drive) => '/mnt/' + drive.toLowerCase())
    .replaceAll('\\', '/')
export function readExifTool(files) {
  if (!existsSync(script)) {
    if (process.env.OPENLR_TEST_METADATA === '1')
      throw Error('Required independent ExifTool source is missing; see docs/export-metadata.md')
    return null
  }
  const args = ['-j', '-G1', '-a', '-s', '-n', ...files]
  const output =
    process.platform === 'win32'
      ? execFileSync('wsl', ['-e', 'perl', linuxPath(script), ...args.slice(0, 5), ...files.map(linuxPath)], {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024
        })
      : execFileSync('perl', [script, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(output)
}
