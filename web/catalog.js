const connection = new Promise((resolve, reject) => {
  const request = indexedDB.open('openlr', 4)
  request.onupgradeneeded = () => {
    for (const name of ['photos','originals','albums','presets','sync','media','mediaRecords']) {
      if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'id'})
    }
  }
  request.onsuccess = () => {request.result.onversionchange=()=>request.result.close();resolve(request.result)}
  request.onerror = () => reject(request.error)
})

export async function transaction(stores, mode, work,mediaPlan) {
  const db = await connection
  return new Promise((resolve, reject) => {
    const names=Array.isArray(stores)?[...stores]:[stores]
    const mediaWrite=mode==='readwrite'&&names.some(name=>name==='photos'||name==='originals')
    if(mediaWrite)for(const name of ['media','mediaRecords'])if(!names.includes(name))names.push(name)
    const tx = db.transaction(names, mode)
    let result,cause
    tx.oncomplete = () => resolve(result?.result)
    tx.onerror = e => {cause??=e.target.error}
    tx.onabort = () => reject(cause??tx.error??new Error('Catalog transaction aborted'))
    try{
      if(mediaPlan){
        for(const {reference}of mediaPlan.reused.values()){
          const exists=tx.objectStore('media').getKey([reference.key,0])
          exists.onsuccess=()=>{
            if(exists.result!==undefined)return
            cause=Object.assign(new Error('A cached media reference was reclaimed'),{code:'MEDIA_REFERENCE_MISSING'})
            tx.abort()
          }
        }
        for(const chunk of mediaPlan.chunks)tx.objectStore('media').put(chunk)
        for(const row of mediaPlan.records)tx.objectStore('mediaRecords').put(row)
      }
      result=work(tx)
      if(mediaWrite)collectUnused(tx)
    }catch(error){cause=error;tx.abort()}
  })
}
const mediaFields=['file','thumbnail','radiance']
export const MEDIA_CHUNK_BYTES=8*1024*1024
let binaryStorage=false
const mediaReferences=new WeakMap()
function descriptorKeys(row){return [...new Set(mediaFields.map(key=>row[key]).filter(value=>value?.storage==='chunks-v2').map(value=>value.key))]}
function collectUnused(tx){
  const owners=tx.objectStore('mediaRecords').getAll(),keys=tx.objectStore('media').getAllKeys()
  let ready=0
  const finish=()=>{
    if(++ready!==2)return
    const used=new Set(owners.result.flatMap(owner=>owner.keys))
    for(const key of keys.result)if(!used.has(key[0]))tx.objectStore('media').delete(key)
  }
  owners.onsuccess=keys.onsuccess=finish
}
async function hydrate(record){
  if(!record)return record
  for(const key of mediaFields){
    const v=record[key]
    if(v?.storage==='bytes-v1')record[key]=v.name!==undefined?new File([v.bytes],v.name,{type:v.type,lastModified:v.modified}):new Blob([v.bytes],{type:v.type})
    if(v?.storage==='chunks-v2'){
      if(!Number.isSafeInteger(v.count)||v.count<1||!Number.isSafeInteger(v.size)||v.size<0)throw Error('Invalid catalog media descriptor')
      const chunks=await transaction('media','readonly',tx=>{
        const parts=[],request=tx.objectStore('media').openCursor(IDBKeyRange.bound([v.key,0],[v.key,v.count-1]))
        request.onsuccess=()=>{const cursor=request.result;if(cursor){parts.push(cursor.value.bytes);cursor.continue()}}
        return {result:parts}
      })
      if(chunks.length!==v.count||chunks.reduce((size,part)=>size+part.byteLength,0)!==v.size)throw Error('The catalog is missing part of an original image')
      const blob=v.name!==undefined?new File(chunks,v.name,{type:v.type,lastModified:v.modified}):new Blob(chunks,{type:v.type})
      mediaReferences.set(blob,v);record[key]=blob
    }
  }
  return record
}
async function packMedia(rows){
  const plan={chunks:[],records:[],references:[],reused:new Map()},planned=new WeakMap(),packed=[]
  for(const row of rows){
    const next={...row}
    for(const key of mediaFields){
      const blob=row[key]
      if(!(blob instanceof Blob))continue
      const cached=mediaReferences.get(blob)
      if(cached)plan.reused.set(cached.key,{blob,reference:cached})
      let reference=cached||planned.get(blob)
      if(!reference&&(binaryStorage||blob.size>MEDIA_CHUNK_BYTES)){
        reference={storage:'chunks-v2',key:crypto.randomUUID(),count:Math.max(1,Math.ceil(blob.size/MEDIA_CHUNK_BYTES)),size:blob.size,type:blob.type,...(blob instanceof File?{name:blob.name,modified:blob.lastModified}:{})}
        for(let index=0;index<reference.count;index++)plan.chunks.push({id:[reference.key,index],bytes:await blob.slice(index*MEDIA_CHUNK_BYTES,(index+1)*MEDIA_CHUNK_BYTES).arrayBuffer()})
        planned.set(blob,reference);plan.references.push([blob,reference])
      }
      if(reference)next[key]=reference
    }
    if(Object.hasOwn(row,'file')||Object.hasOwn(row,'thumbnail'))plan.records.push({id:[Object.hasOwn(row,'file')?'originals':'photos',row.id],keys:descriptorKeys(next)})
    packed.push(next)
  }
  return {packed,plan}
}
// Media chunks, owner records, catalog writes and orphan cleanup commit or abort
// together. Writers use the supplied commit callback, never a global context.
export async function withMedia(rows,write){
  for(;;){
    const {packed,plan}=await packMedia(rows)
    try{
      const result=await write(packed,(stores,mode,work)=>transaction(stores,mode,work,plan))
      for(const [blob,reference]of plan.references)mediaReferences.set(blob,reference)
      return result
    }catch(error){
      if(error.code==='MEDIA_REFERENCE_MISSING'){
        for(const {blob}of plan.reused.values())mediaReferences.delete(blob)
        continue
      }
      if(binaryStorage||!/preparing (blob|file)|blob.*(stor|support)|file.*could not be cloned/i.test(error.message))throw error
      binaryStorage=true
    }
  }
}
export const all = async name => Promise.all((await transaction(name, 'readonly', tx => tx.objectStore(name).getAll())).map(hydrate))
export const original = async id => hydrate(await transaction('originals', 'readonly', tx => tx.objectStore('originals').get(id)))
export const save = (name, record) => withMedia([record],([row],commit)=>commit(name,'readwrite',tx=>tx.objectStore(name).put(row)))
export function deleteRecord(tx,store,id){
  if(tx.objectStoreNames.contains('mediaRecords'))tx.objectStore('mediaRecords').delete([store,id])
  return tx.objectStore(store).delete(id)
}
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
export function addPhoto(photo, file, extra={}) {
  return withMedia([photo,{id:photo.id,file,...extra}],([row,original],commit)=>
    commit(['photos','originals'],'readwrite',tx=>{
      tx.objectStore('photos').add(row)
      tx.objectStore('originals').add(original)
    }))
}
