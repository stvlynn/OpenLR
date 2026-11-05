import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  COLOR_SPACES,
  convertRgbColor,
  convertLinearSrgbColor,
  convertSrgbPixels,
  makeColorProfile
} from '../web/color-spaces.js'

const spaces = Object.keys(COLOR_SPACES)
const clamp = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255)
const close = (actual, expected, tolerance = 1e-8) =>
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) < tolerance, `${actual} != ${expected}`)
  )

test('named spaces convert actual colors, preserve neutral axes and support float roundtrips', () => {
  assert.deepEqual(spaces, ['srgb', 'display-p3', 'adobe-rgb', 'prophoto-rgb', 'rec2020'])
  // Independent published Display P3 conversion reference, rounded to 7 decimals.
  close(convertRgbColor([1, 0, 0], 'srgb', 'display-p3'), [0.9174876, 0.2002868, 0.1385606], 1e-7)
  for (const space of spaces) {
    for (const color of [
      [0, 0, 0],
      [1, 1, 1],
      [0.15, 0.5, 0.9],
      [-0.1, 1.2, 0.4]
    ]) {
      const converted = convertRgbColor(color, 'srgb', space)
      close(convertRgbColor(converted, space, 'srgb'), color)
    }
    for (const level of [0, 1 / 255, 0.03125, 0.04045, 0.5, 1]) {
      const converted = convertRgbColor([level, level, level], 'srgb', space)
      close(converted, [converted[0], converted[0], converted[0]])
    }
  }
  assert.ok(convertRgbColor([1, 0, 0], 'display-p3', 'srgb')[0] > 1)
  close(convertLinearSrgbColor([0.21404114048223255, 0, 1]), [0.5, 0, 1])
  assert.throws(() => convertRgbColor([1, 0, NaN]), /finite/)
  assert.throws(() => convertRgbColor([0, 0, 0], 'unknown'), /Unknown/)
  assert.throws(() => makeColorProfile('__proto__'), /Unknown/)
})

test('byte conversion has exact sRGB identity, immutable input and unassociated alpha', () => {
  const data = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < 256; i++) data.set([i, 255 - i, (i * 13) % 256, i], i * 4)
  const original = data.slice()
  for (const space of spaces) {
    const output = convertSrgbPixels({ data, width: 256, height: 1 }, space)
    assert.ok(output.data instanceof Uint8ClampedArray)
    assert.equal(output.width, 256)
    assert.equal(output.height, 1)
    for (let i = 0; i < 256; i++) {
      const expected = convertRgbColor(
        Array.from(data.slice(i * 4, i * 4 + 3), (value) => value / 255),
        'srgb',
        space
      ).map(clamp)
      assert.deepEqual(Array.from(output.data.slice(i * 4, i * 4 + 3)), expected)
      assert.equal(output.data[i * 4 + 3], i)
    }
    if (space === 'srgb') assert.deepEqual(output.data, data)
  }
  assert.deepEqual(data, original)
  assert.throws(() => convertSrgbPixels({ data, width: 255, height: 1 }), /tightly packed/)
})

test('ICC v4 profile records are deterministic and use D50 PCS with valid tag bounds', () => {
  for (const space of spaces) {
    const bytes = makeColorProfile(space),
      view = new DataView(bytes.buffer)
    const sig = (offset) => String.fromCharCode(...bytes.slice(offset, offset + 4))
    assert.deepEqual(bytes, makeColorProfile(space))
    assert.equal(view.getUint32(0), bytes.length)
    assert.equal(sig(36), 'acsp')
    assert.equal(sig(12), 'mntr')
    assert.equal(sig(16), 'RGB ')
    assert.equal(sig(20), 'XYZ ')
    assert.equal(view.getUint32(64), 1)
    assert.equal(view.getInt32(68), 0xf6d6)
    assert.equal(view.getInt32(76), 0xd32d)
    const tags = {}
    for (let i = 0; i < view.getUint32(128); i++) {
      const offset = view.getUint32(136 + i * 12),
        length = view.getUint32(140 + i * 12)
      assert.equal(offset % 4, 0)
      assert.ok(offset + length <= bytes.length)
      tags[sig(132 + i * 12)] = { offset, length }
    }
    for (const tag of ['desc', 'cprt', 'wtpt', 'chad', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'])
      assert.ok(tags[tag])
    for (let row = 0; row < 3; row++) {
      const sum = ['rXYZ', 'gXYZ', 'bXYZ'].reduce(
        (value, tag) => value + view.getInt32(tags[tag].offset + 8 + row * 4),
        0
      )
      assert.ok(
        Math.abs(sum - view.getInt32(68 + row * 4)) <= 1,
        'colorants sum to PCS white within fixed-point rounding'
      )
    }
  }
})

// Only this optional independent integration check requires a validation tool.
// Set OPENLR_TEST_CMS=1 to make missing Pillow a failure; production has no Pillow dependency.
const cmsPython = String.raw`
import sys,json,io,math
from PIL import Image, ImageCms, __version__
p=json.load(sys.stdin)
colors=p['colors']
source=Image.new('RGB',(len(colors),1)); source.putdata([tuple(c) for c in colors])
profiles={k:ImageCms.ImageCmsProfile(io.BytesIO(bytes(v))) for k,v in p['profiles'].items()}
srgb=ImageCms.createProfile('sRGB'); lab=ImageCms.createProfile('LAB')
flags=ImageCms.Flags.NOOPTIMIZE
def transform(image,a,b,mode='RGB'):
    return ImageCms.applyTransform(image,ImageCms.buildTransform(a,b,'RGB',mode,renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,flags=flags))
def lab_values(image,profile):
    # Pillow's unsigned Lab8 transport: 0..255 L represents 0..100; a,b are offset by 128.
    return [(c[0]*100/255,c[1]-128,c[2]-128) for c in transform(image,profile,lab,'LAB').getdata()]
def delta(a,b): return math.sqrt(sum((x-y)**2 for x,y in zip(a,b)))
reference=lab_values(source,srgb)
metrics={}
for name,profile in profiles.items():
    assert profile.profile.xcolor_space.strip()=='RGB'
    assert profile.profile.connection_space.strip()=='XYZ'
    assert profile.profile.is_matrix_shaper
    expected=p['expected'][name]
    own=list(transform(source,profiles['srgb'],profile).getdata())
    independent=list(transform(source,srgb,profile).getdata())
    max_own=max(abs(a-b) for x,y in zip(own,expected) for a,b in zip(x,y))
    max_independent=max(abs(a-b) for x,y in zip(independent,expected) for a,b in zip(x,y))
    # The two separately rounded colorant matrices can leak <=2 byte levels at
    # Adobe RGB's pure-blue boundary. Independent built-in sRGB stays within 1.
    # See the recorded failed initial threshold and explanation in the experiment.
    assert max_own<=(2 if name=='adobe-rgb' else 1),(name,'generated source',max_own)
    assert max_independent<=1,(name,'independent built-in source',max_independent)
    corrected=Image.new('RGB',source.size); corrected.putdata([tuple(c) for c in expected])
    actual_lab=lab_values(corrected,profile)
    wrong_lab=lab_values(source,profile)
    errors=sorted(delta(a,b) for a,b in zip(reference,actual_lab))
    wrong_errors=sorted(delta(a,b) for a,b in zip(reference,wrong_lab))
    mean=sum(errors)/len(errors); wrong=sum(wrong_errors)/len(wrong_errors)
    assert mean<1.5,(name,'mean deltaE',mean)
    if name!='srgb': assert wrong>3,(name,'label-only deltaE',wrong)
    metrics[name]={'maxByteErrorGeneratedSource':max_own,'worstExamples':[(colors[i],list(own[i]),expected[i]) for i in range(len(colors)) if max(abs(a-b) for a,b in zip(own[i],expected[i]))==max_own][:3],'maxByteErrorBuiltinSource':max_independent,'meanDeltaE76':round(mean,5),'p99DeltaE76':round(errors[int(.99*(len(errors)-1))],5),'maxDeltaE76':round(errors[-1],5),'labelOnlyMeanDeltaE76':round(wrong,5)}
print(json.dumps({'pillow':__version__,'lcms':ImageCms.core.littlecms_version,'samples':len(colors),'metrics':metrics}))
`

test('independent Little CMS parses profiles, transforms 17-cube and rejects label-only ablation', (t) => {
  const python = process.env.OPENLR_CMS_PYTHON || 'python'
  const env = {
    ...process.env,
    PYTHONPATH: [resolve('.tools/color-cms'), process.env.PYTHONPATH]
      .filter(Boolean)
      .join(process.platform === 'win32' ? ';' : ':')
  }
  const available = spawnSync(python, ['-c', 'from PIL import ImageCms'], {
    env,
    encoding: 'utf8',
    windowsHide: true
  })
  if (available.status !== 0 && process.env.OPENLR_TEST_CMS !== '1')
    return t.skip(
      'Pillow ImageCms unavailable; set OPENLR_TEST_CMS=1 for required independent CMS validation'
    )
  assert.equal(available.status, 0, available.stderr)
  const colors = []
  for (let r = 0; r <= 16; r++)
    for (let g = 0; g <= 16; g++)
      for (let b = 0; b <= 16; b++) colors.push([r, g, b].map((value) => Math.round((value * 255) / 16)))
  for (let i = 0; i < 256; i++) colors.push([i, i, i])
  for (let i = 0; i < 32; i++) colors.push([i, 0, 0], [0, i, 0], [0, 0, i])
  const profiles = Object.fromEntries(spaces.map((space) => [space, Array.from(makeColorProfile(space))]))
  const expected = Object.fromEntries(
    spaces.map((space) => [
      space,
      colors.map((color) =>
        convertRgbColor(
          color.map((value) => value / 255),
          'srgb',
          space
        ).map(clamp)
      )
    ])
  )
  const result = spawnSync(python, ['-c', cmsPython], {
    input: JSON.stringify({ colors, profiles, expected }),
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  })
  assert.equal(result.status, 0, result.stderr)
  t.diagnostic(result.stdout.trim())
})
