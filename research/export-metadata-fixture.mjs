// Original generated pixels and fictitious metadata; no camera or personal file.
import { mkdir, writeFile } from 'node:fs/promises'
import { makePng } from '../tests/fixtures/png.mjs'

const output = new URL('../.workspace/export-metadata/', import.meta.url)
await mkdir(output, { recursive: true })
await writeFile(
  new URL('source.png', output),
  makePng({ width: 32, height: 24, bits: 8, colorType: 2, srgb: 0 })
)
await writeFile(
  new URL('source.args', output),
  [
    '-overwrite_original',
    '-charset',
    'UTF8',
    '-Copyright=ASCII copyright fixture',
    '-Artist=Example Photographer',
    '-Make=OpenLR Fixture',
    '-Model=Generated Camera',
    '-LensModel=Generated 50mm',
    '-DateTimeOriginal=2024:06:07 08:09:10',
    '-OffsetTimeOriginal=+08:00',
    '-SubSecTimeOriginal=125',
    '-ExposureTime=1/125',
    '-FNumber=2.8',
    '-ISO=200',
    '-FocalLength=50',
    '-Orientation#=6',
    '-GPSLatitude=1.25',
    '-GPSLatitudeRef=N',
    '-GPSLongitude=2.5',
    '-GPSLongitudeRef=E',
    '-XMP-dc:Rights=© 示例 & <rights> 📷 é',
    '-XMP-dc:Creator=创作者 Example',
    '-XMP-dc:Subject=Private fixture keyword',
    '-XMP-crs:Exposure2012=3',
    ''
  ].join('\n'),
  'utf8'
)
console.log(
  'Generated .workspace/export-metadata/source.png and source.args; apply args with the independent ExifTool oracle.'
)
