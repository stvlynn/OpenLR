// Original generated 12-bit RGGB sensor fixture in an uncompressed DNG container.
// No embedded JPEG/preview: a successful render must unpack the sensor samples.
export function makeDng({ width = 128, height = 96, orientation = 1, exposure = 1 } = {}) {
  const tags = []
  const values = (type, list) => {
    if (type === 2) return Uint8Array.from([...(list + '\0')].map((c) => c.charCodeAt(0)))
    if (type === 1) return Uint8Array.from(list)
    const bytes = new Uint8Array(list.length * { 3: 2, 4: 4, 5: 8, 10: 8 }[type]),
      view = new DataView(bytes.buffer)
    list.forEach((value, index) => {
      if (type === 3) view.setUint16(index * 2, value, true)
      else if (type === 4) view.setUint32(index * 4, value, true)
      else {
        view.setInt32(index * 8, value[0], true)
        view.setInt32(index * 8 + 4, value[1], true)
      }
    })
    return bytes
  }
  const add = (id, type, value) =>
    tags.push({ id, type, bytes: values(type, value), count: type === 2 ? value.length + 1 : value.length })
  add(254, 4, [0])
  add(256, 4, [width])
  add(257, 4, [height])
  add(258, 3, [16])
  add(259, 3, [1])
  add(262, 3, [32803])
  add(271, 2, 'OpenLR')
  add(272, 2, 'Generated RGGB')
  add(273, 4, [0])
  add(274, 3, [orientation])
  add(277, 3, [1])
  add(278, 4, [height])
  add(279, 4, [width * height * 2])
  add(284, 3, [1])
  add(33421, 3, [2, 2])
  add(33422, 1, [0, 1, 1, 2])
  add(50706, 1, [1, 4, 0, 0])
  add(50707, 1, [1, 1, 0, 0])
  add(50708, 2, 'OpenLR Generated RGGB')
  add(50710, 1, [0, 1, 2])
  add(50711, 3, [1])
  add(50713, 3, [1, 1])
  add(50714, 3, [256])
  add(50717, 4, [4095])
  add(50719, 4, [0, 0])
  add(50720, 4, [width, height])
  add(50721, 10, [
    [1, 1],
    [0, 1],
    [0, 1],
    [0, 1],
    [1, 1],
    [0, 1],
    [0, 1],
    [0, 1],
    [1, 1]
  ])
  add(50728, 5, [
    [1, 1],
    [1, 1],
    [1, 1]
  ])
  add(50778, 3, [21])
  tags.sort((a, b) => a.id - b.id)
  let end = 8 + 2 + tags.length * 12 + 4
  for (const tag of tags)
    if (tag.bytes.length > 4) {
      tag.offset = end
      end += tag.bytes.length + (tag.bytes.length % 2)
    }
  new DataView(tags.find((tag) => tag.id === 273).bytes.buffer).setUint32(0, end, true)
  const bytes = new Uint8Array(end + width * height * 2),
    view = new DataView(bytes.buffer)
  view.setUint16(0, 0x4949, true)
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)
  view.setUint16(8, tags.length, true)
  tags.forEach((tag, index) => {
    const start = 10 + index * 12
    view.setUint16(start, tag.id, true)
    view.setUint16(start + 2, tag.type, true)
    view.setUint32(start + 4, tag.count, true)
    if (tag.offset) {
      view.setUint32(start + 8, tag.offset, true)
      bytes.set(tag.bytes, tag.offset)
    } else bytes.set(tag.bytes, start + 8)
  })
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const channel = y % 2 === 0 ? (x % 2 === 0 ? 0 : 1) : x % 2 === 0 ? 1 : 2
      const patch = Math.min(2, Math.floor((x * 3) / width))
      const sample = channel === patch ? 2600 + Math.round((y / height) * 500) : 400
      view.setUint16(
        end + (y * width + x) * 2,
        Math.max(256, Math.min(4095, Math.round(256 + (sample - 256) * exposure))),
        true
      )
    }
  return bytes
}
