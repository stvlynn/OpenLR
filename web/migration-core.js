// Independent read-only adapter for documented Lightroom SQLite relationships.
// Schema evidence and intentional version limits: research/catalog-migration.md.
const decoder=new TextDecoder()
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('')
const text=value=>typeof value==='string'?value:''
export function relativeResource(value){
  const path=String(value).replaceAll('\\','/').replace(/^\.\//,'')
  if(!path||path.startsWith('/')||path.split('/').some(piece=>!piece||piece==='.'||piece==='..')||/[:\u0000]/.test(path))throw Error('Resource path must stay inside the selected folder')
  return path
}
export function scalarDevelop(text){
  // Lex scalars at the first table level only; never evaluate Lua/JavaScript.
  if(typeof text!=='string')return {}
  const tokens=text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][\w]*|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[{}=,;]/g)??[]
  const values={};let depth=0
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i]
    if(token==='{'){depth++;continue}if(token==='}'){depth--;continue}
    if(depth!==1||!/^[A-Za-z_]\w*$/.test(token)||tokens[i+1]!=='=')continue
    const next=tokens[i+2]
    if(/^[-+]?(?:\d|\.)/.test(next)&&Number.isFinite(Number(next)))values[token]=Number(next)
    else if(next==='true'||next==='false')values[token]=next==='true'
    else if(next?.startsWith('"')){try{values[token]=JSON.parse(next)}catch{}}
  }
  return values
}
export async function xmpText(value){
  if(typeof value==='string')return value
  if(!(value instanceof Uint8Array)||!value.length)return ''
  if(decoder.decode(value.subarray(0,100)).trimStart().startsWith('<'))return decoder.decode(value)
  if(value.length<6)throw Error('Unsupported catalog XMP encoding')
  const expected=new DataView(value.buffer,value.byteOffset,4).getUint32(0,false)
  const stream=new Blob([value.subarray(4)]).stream().pipeThrough(new DecompressionStream('deflate'))
  const bytes=new Uint8Array(await new Response(stream).arrayBuffer())
  if(bytes.length!==expected)throw Error('Catalog XMP length/header mismatch')
  return decoder.decode(bytes)
}
export async function scanCatalog(file,SQL){
  if(!(file instanceof Blob))throw Error('Choose a Lightroom Classic .lrcat file')
  const bytes=new Uint8Array(await file.arrayBuffer())
  if(decoder.decode(bytes.subarray(0,16))!=='SQLite format 3\u0000')throw Error('This is not an unencrypted SQLite Lightroom Classic catalog')
  const db=new SQL.Database(bytes),warnings=[]
  try{
    db.run('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON')
    const query=sql=>{const stmt=db.prepare(sql),rows=[];try{while(stmt.step())rows.push(stmt.getAsObject())}finally{stmt.free()}return rows}
    const tables=new Set(query("SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'").map(row=>row.name))
    const columns=table=>tables.has(table)?new Set(query('PRAGMA table_info("'+table+'")').map(row=>row.name)):new Set()
    const required={Adobe_images:['id_local','rootFile'],AgLibraryFile:['id_local','folder','baseName','extension'],AgLibraryFolder:['id_local','rootFolder','pathFromRoot'],AgLibraryRootFolder:['id_local','absolutePath']}
    for(const [table,fields]of Object.entries(required))for(const name of fields)if(!columns(table).has(name))throw Error('Unsupported Classic catalog schema: missing '+table+'.'+name)
    const rows=table=>tables.has(table)?query('SELECT * FROM "'+table+'"'):[]
    const variables=[...rows('Adobe_variablesTable'),...rows('Adobe_variables')]
    const version=String(variables.find(row=>row.name==='Adobe_DBVersion')?.value??'unknown')
    const rootRows=rows('AgLibraryRootFolder'),roots=rootRows.map(row=>({id:String(row.id_local),path:text(row.absolutePath),name:text(row.name)}))
    const uuid=variables.find(row=>/catalog.*(uuid|id)$/i.test(row.name??''))?.value
    const namespace=(await hash(new TextEncoder().encode(JSON.stringify(uuid??{name:file.name,roots:roots.map(root=>root.path).sort()})))).slice(0,24)
    const index=items=>new Map(items.map(row=>[String(row.id_local),row]))
    const files=index(rows('AgLibraryFile')),folders=index(rows('AgLibraryFolder')),rootMap=index(rootRows)
    const keywords=index(rows('AgLibraryKeyword')),keywordImages=rows('AgLibraryKeywordImage'),collectionRows=rows('AgLibraryCollection'),collections=index(collectionRows)
    const grouped=items=>{const map=new Map();for(const row of items){const id=String(row.image);if(!map.has(id))map.set(id,[]);map.get(id).push(row)}return map}
    const keywordMap=grouped(keywordImages),membership=grouped(rows('AgLibraryCollectionImage')),develop=grouped(rows('Adobe_imageDevelopSettings')),extra=grouped(rows('Adobe_AdditionalMetadata'))
    const smart=collectionRows.filter(row=>/smart/i.test(row.creationId??''))
    if(smart.length)warnings.push({code:'smart-collections',count:smart.length,message:'Smart collection rules are not translated.'})
    const hierarchy=(row,seen=new Set())=>{if(!row||seen.has(String(row.id_local)))return [];seen.add(String(row.id_local));return [...hierarchy(collections.get(String(row.parent)),seen),text(row.name)||'Untitled']}
    const albums=collectionRows.filter(row=>!row.systemOnly&&!/smart|\.group$/i.test(row.creationId??'')).map(row=>({id:'lr-album:'+namespace+':'+row.id_local,name:(file.name??'Classic').replace(/\.lrcat$/i,'')+' / '+hierarchy(row).join(' / '),sourceId:String(row.id_local)}))
    const albumMap=new Map(albums.map(row=>[row.sourceId,row.id])),photos=[]
    for(const image of rows('Adobe_images')){
      const id=String(image.id_local),fileRow=files.get(String(image.rootFile)),folder=folders.get(String(fileRow?.folder)),root=rootMap.get(String(folder?.rootFolder))
      const name=fileRow?(text(fileRow.idx_filename)||text(fileRow.baseName)+(text(fileRow.extension)?'.'+text(fileRow.extension):'')):''
      const photo={id:'lr:'+namespace+':'+(image.id_global||id),sourceId:id,name,sourceRoot:root?String(root.id_local):null,sourcePath:root?text(root.absolutePath)+text(folder.pathFromRoot)+name:null,
        rating:Number.isInteger(image.rating)&&image.rating>=0&&image.rating<=5?image.rating:0,flag:image.pick===1?'pick':image.pick===-1?'reject':'',colorLabel:['red','yellow','green','blue','purple'].includes(text(image.colorLabels).toLowerCase())?image.colorLabels.toLowerCase():'',
        keywords:(keywordMap.get(id)??[]).map(row=>text(keywords.get(String(row.tag))?.name)).filter(Boolean).join(', '),albums:(membership.get(id)??[]).map(row=>albumMap.get(String(row.collection))).filter(Boolean),
        width:Number(image.fileWidth)||0,height:Number(image.fileHeight)||0,masterImage:image.masterImage??null,copyName:image.copyName??null,orientation:image.orientation??null,captureTime:image.captureTime??null,
        develop:scalarDevelop(develop.get(id)?.[0]?.text),xmp:null,warnings:[]}
      if(!fileRow||!folder||!root||!root.absolutePath||!name)photo.error='incomplete-catalog-record'
      else try{photo.relative=relativeResource(text(folder.pathFromRoot)+name)}catch{photo.error='unsafe-resource-path'}
      try{photo.xmp=await xmpText(extra.get(id)?.[0]?.xmp)}catch(error){photo.warnings.push(error.message)}
      if(image.masterImage)photo.warnings.push('Virtual copy metadata is retained as a separate photo; source pixels are shared.')
      if(develop.get(id)?.[0]?.hasBigData||develop.get(id)?.[0]?.hasMasks)photo.warnings.push('Masks/AI big-data and proprietary rendering are not migrated.')
      photos.push(photo)
    }
    if(!tables.has('AgLibraryCollection'))warnings.push({code:'no-collections',message:'No supported collection table; albums cannot be recovered.'})
    warnings.push({code:'rendering-differences',message:'Supported develop scalars are mapped approximately; Adobe profiles, local masks, history, faces, smart rules, stacks and creations are not reproduced.'})
    return {id:'migration:'+namespace,kind:'lrcat',name:file.name??'Classic catalog',namespace,sourceSha256:await hash(bytes),schemaVersion:version,schemaPolicy:'Required table/column capabilities; no Adobe release compatibility claim',roots,photos,albums,warnings,created:Date.now(),mappings:[]}
  }finally{db.close()}
}
