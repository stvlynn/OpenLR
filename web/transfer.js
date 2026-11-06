export function decodeBase64(value) {
  const raw = atob(value),
    bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

export function decodeFile(payload) {
  if (!payload || typeof payload.name !== 'string' || typeof payload.base64 !== 'string')
    throw Error('Invalid photo payload')
  return new File([decodeBase64(payload.base64)], payload.name, {
    type: payload.type || 'application/octet-stream',
    lastModified: payload.lastModified ?? Date.now()
  })
}

export async function encodeBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(reader.error ?? new Error('Cannot read image bytes'))
    reader.readAsDataURL(blob)
  })
}
