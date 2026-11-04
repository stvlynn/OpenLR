const connection = new Promise((resolve, reject) => {
  const request = indexedDB.open('openlr', 1)
  request.onupgradeneeded = () => {
    for (const name of ['photos', 'originals', 'albums']) request.result.createObjectStore(name, { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

export async function transaction(stores, mode, work) {
  const db = await connection
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    const result = work(tx)
    tx.oncomplete = () => resolve(result?.result)
    tx.onabort = () => reject(tx.error ?? new Error('Catalog transaction aborted'))
  })
}
export const all = name => transaction(name, 'readonly', tx => tx.objectStore(name).getAll())
export const original = id => transaction('originals', 'readonly', tx => tx.objectStore('originals').get(id))
export const save = (name, record) => transaction(name, 'readwrite', tx => tx.objectStore(name).put(record))
export async function removeAlbum(id){
  return transaction(['albums','photos'],'readwrite',tx=>{
    tx.objectStore('albums').delete(id)
    const request=tx.objectStore('photos').openCursor()
    request.onsuccess=()=>{
      const cursor=request.result
      if(!cursor)return
      if(cursor.value.albums.includes(id))cursor.update({...cursor.value,albums:cursor.value.albums.filter(value=>value!==id)})
      cursor.continue()
    }
  })
}
export function addPhoto(photo, file) {
  return transaction(['photos','originals'], 'readwrite', tx => {
    tx.objectStore('photos').add(photo)
    tx.objectStore('originals').add({id:photo.id, file})
  })
}
export function purge(id) {
  return transaction(['photos','originals'], 'readwrite', tx => {
    for (const name of ['photos','originals']) tx.objectStore(name).delete(id)
  })
}
