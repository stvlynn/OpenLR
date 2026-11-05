// Shared escaping for OpenLR's recipe and rendered-metadata XML writers.
export const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

export function assertXmlText(value) {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (!(
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff)
    ))
      throw Error('Photo metadata contains text that cannot be represented in XML')
  }
  return value
}
