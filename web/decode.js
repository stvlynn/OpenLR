// One codec boundary for import, reopening originals, preview, and export.
export const RAW_EXTENSIONS=['3fr','ari','arw','bay','braw','cap','cine','cr2','cr3','crw','cs1','dc2','dcr','dng','drf','eip','erf','fff','gpr','iiq','k25','kdc','mdc','mef','mos','mrw','nef','nrw','obm','orf','pef','ptx','pxn','qtk','raf','raw','rdc','rw2','rwl','rwz','sr2','srf','srw','sti','x3f']
export const PHOTO_ACCEPT='image/*,'+RAW_EXTENSIONS.map(ext=>'.'+ext).join(',')
const MESSAGES={
  EMPTY:'The photo is empty.',
  RAW_DECODE:'This RAW format or compression could not be decoded.',
  RAW_LAYOUT:'The RAW decoder returned an unsupported pixel layout.',
  RAW_WORKER:'The RAW decoder could not start or ran out of memory.',
  RAW_TIMEOUT:'The RAW decoder exceeded its two minute time limit.',
  IMAGE_DECODE:'This image format could not be decoded.'
}
export class PhotoDecodeError extends Error {
  constructor(code, cause){ super(MESSAGES[code] || MESSAGES.RAW_DECODE,{cause}); this.name='PhotoDecodeError'; this.code=code }
}
let rawQueue=Promise.resolve()
function decodeRaw(file){
  return new Promise((resolve,reject)=>{
    let worker, timer
    const finish=(error,bitmap)=>{
      clearTimeout(timer)
      worker?.terminate()
      if(error) reject(error); else resolve(bitmap)
    }
    try{
      worker=new Worker(new URL('./decode-worker.js',import.meta.url),{type:'module'})
      timer=setTimeout(()=>finish(new PhotoDecodeError('RAW_TIMEOUT')),120000)
      worker.onmessage=({data})=>{
        if(data.bitmap) finish(null,data.bitmap)
        else finish(new PhotoDecodeError(data.code || 'RAW_DECODE'))
      }
      worker.onerror=event=>{event.preventDefault();finish(new PhotoDecodeError('RAW_WORKER'))}
      worker.onmessageerror=()=>finish(new PhotoDecodeError('RAW_WORKER'))
      // Blob is immutable and structured-cloned without changing the catalog original.
      worker.postMessage({file})
    }catch(error){finish(new PhotoDecodeError('RAW_WORKER',error))}
  })
}
export async function decodePhoto(file){
  if(!file?.size) throw new PhotoDecodeError('EMPTY')
  const extension=(file.name || '').split('.').pop().toLowerCase()
  if(!RAW_EXTENSIONS.includes(extension)){
    try{return await createImageBitmap(file)}
    catch(error){throw new PhotoDecodeError('IMAGE_DECODE',error)}
  }
  // RAW memory can be substantial. Serialize decodes and discard each WASM heap.
  const pending=rawQueue.then(()=>decodeRaw(file))
  rawQueue=pending.then(()=>{},()=>{})
  return pending
}
