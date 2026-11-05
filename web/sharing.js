import { renderPrepared as render } from './render.js'
import { encodePhoto } from './encode.js'
import { encodeBlob } from './transfer.js'
let output
const call = (method, ...args) => {
  if (!globalThis.mygo?.call) throw Error('Publishing shared albums requires the desktop app.')
  return globalThis.mygo.call('Sharing.' + method, ...args)
}
export const configure = async ({ endpoint, token }) => {
  await call('Configure', endpoint, token)
  return { configured: true, endpoint }
}
export async function publish(album, photos, readImage, { comments = true, likes = true } = {}) {
  if (!photos.length) throw Error('The selected album has no photos to share')
  await call('Prepare', album.id, album.name, comments, likes)
  const published = []
  for (const photo of photos) {
    if (/\.(mov|mp4|m4v|webm|mkv)$/i.test(photo.name)) throw Error('Video album sharing is not supported')
    const image = await readImage(photo.id),
      canvas = await render(image, photo.edit, 1920),
      blob = await encodePhoto(canvas, 'image/jpeg', 0.9)
    await call('Upload', album.id, photo.id, await encodeBlob(blob))
    published.push({ id: photo.id, name: photo.name })
  }
  const manifest = JSON.parse(await call('Publish', album.id, JSON.stringify(published))),
    state = await call('State')
  const url =
    state.endpoint + '/albums/' + encodeURIComponent(album.id) + '/?key=' + encodeURIComponent(manifest.token)
  if (output) {
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = 'Open shared album'
    output.replaceChildren(link)
  }
  return {
    id: album.id,
    title: album.name,
    photos: published.length,
    url,
    access: 'Anyone with this secret link',
    comments: manifest.allowComments,
    likes: manifest.allowLikes
  }
}
export async function reviews(id) {
  const album = JSON.parse(await call('Reviews', id))
  const result = {
    id: album.id,
    title: album.title,
    comments: album.comments,
    likes: album.likes,
    revoked: album.revoked
  }
  if (output) output.textContent = JSON.stringify(result, null, 2)
  return result
}
export const revoke = async (id) => {
  await call('Revoke', id)
  if (output) output.textContent = 'Album link revoked'
  return { id, revoked: true }
}
export function mount(run, report) {
  const section = document.createElement('details')
  section.className = 'album-sharing'
  const title = document.createElement('summary')
  title.textContent = 'Share & review album'
  const endpoint = document.createElement('input')
  endpoint.placeholder = 'Review server URL'
  endpoint.setAttribute('aria-label', 'Review server URL')
  const token = document.createElement('input')
  token.type = 'password'
  token.placeholder = 'Server admin token'
  token.setAttribute('aria-label', 'Review server admin token')
  const button = (label, command, args) => {
    const control = document.createElement('button')
    control.textContent = label
    control.onclick = () =>
      run(command, typeof args === 'function' ? args() : args).catch((error) => report(error.message))
    control.disabled = !globalThis.mygo?.call
    return control
  }
  output = document.createElement('pre')
  output.style.whiteSpace = 'pre-wrap'
  output.setAttribute('role', 'status')
  section.append(
    title,
    endpoint,
    token,
    button('Save server configuration', 'share-configure', () => ({
      endpoint: endpoint.value,
      token: token.value
    })),
    button('Publish current album', 'share-publish'),
    button('Read comments & likes', 'share-reviews'),
    button('Revoke album link', 'share-revoke'),
    output
  )
  document.querySelector('nav').append(section)
  if (globalThis.mygo?.call)
    call('State')
      .then((state) => {
        endpoint.value = state.endpoint || ''
        if (state.configured) token.placeholder = 'Admin token already configured'
      })
      .catch((error) => report(error.message))
}
