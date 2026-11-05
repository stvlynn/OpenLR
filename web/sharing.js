import { renderPrepared as render } from './render.js'
import { encodePhoto } from './encode.js'
import { encodeBlob } from './transfer.js'
let output
const REVIEW_MESSAGES = {
  empty: 'No comments or likes yet.',
  unavailable: 'Unavailable photo',
  revoked: 'Album link revoked',
  likes: (count) => `${count} ${count === 1 ? 'like' : 'likes'}`
}
function showReviews(album) {
  const node = (tag, text) => {
    const element = document.createElement(tag)
    element.textContent = text
    return element
  }
  const title = node('h3', album.title)
  output.replaceChildren(title)
  if (album.revoked) output.append(node('p', REVIEW_MESSAGES.revoked))
  const comments = album.comments ?? [],
    likes = album.likes ?? {}
  const ids = new Set([...comments.map((comment) => comment.photoId), ...Object.keys(likes)])
  let count = 0
  for (const id of ids) {
    const names = Object.values(likes[id] ?? {})
    const replies = comments.filter((comment) => comment.photoId === id)
    if (!names.length && !replies.length) continue
    const group = document.createElement('article')
    group.append(
      node('h4', album.photos?.find((photo) => photo.id === id)?.name ?? REVIEW_MESSAGES.unavailable)
    )
    if (names.length) group.append(node('p', `${REVIEW_MESSAGES.likes(names.length)} · ${names.join(', ')}`))
    for (const comment of replies) {
      const reply = document.createElement('div')
      reply.className = 'review-comment'
      reply.append(node('strong', comment.name), node('p', comment.text))
      const date = new Date(comment.created)
      if (Number.isFinite(date.getTime())) {
        const time = node('time', date.toLocaleString())
        time.dateTime = date.toISOString()
        reply.append(time)
      }
      group.append(reply)
    }
    output.append(group)
    count++
  }
  if (!count) output.append(node('p', REVIEW_MESSAGES.empty))
}
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
  if (output) showReviews(album)
  return result
}
export const revoke = async (id) => {
  await call('Revoke', id)
  if (output) output.textContent = REVIEW_MESSAGES.revoked
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
  output = document.createElement('div')
  output.className = 'album-reviews'
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
