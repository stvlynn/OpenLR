import {decodePhoto, PHOTO_ACCEPT} from './decode.js'
import * as db from './catalog.js'
import * as local from './local.js'
import {cropGesture, geometry, validCrop} from './geometry.js'
import {drawHistogram,histogram,autoExposure} from './histogram.js'
import {controls, render, toBlob} from './render.js'
import {saveExport} from './desktop.js'
import {Organization,namedVersion,findVersion} from './organization.js'
import {mountOrganization} from './organization-ui.js'
import {LOCAL_COMMANDS,updateLocalTools} from './local-tools.js'
import {createLocalToolsUI} from './local-tools-ui.js'

const $ = id => document.getElementById(id)
const option = (value,label) => new Option(label,value)
let photos=[], albums=[], selected='', scope='all', mode='grid', search='', order='recent'
let compare=false, film=true, zoom=false, cropping=false, bitmap=null, bitmapId='', queue=Promise.resolve()
const urls=new Map(), undo=[], redo=[]
const organization=new Organization()
let updateOrganization=()=>{}
let localToolsUI
const active=()=>photos.find(p=>p.id===selected)
const matches=p=>Boolean(p.deleted)===(scope==='trash') && (['all','trash'].includes(scope) || (scope==='picked' ? p.flag==='pick' : p.albums.includes(scope))) && (p.name+' '+p.keywords).toLowerCase().includes(search.toLowerCase()) && organization.matches(p)
function visible(){
  const result=photos.filter(matches)
  return result.sort((a,b)=>organization.compare(a,b,order))
}
async function source(id) {
  if (bitmapId!==id){
    const data=await original(id)
    const next=await decodePhoto(data.file)
    const photo=photos.find(p=>p.id===id)
    if(photo){photo.width=next.width;photo.height=next.height}
    bitmap?.close()
    bitmap=next
    bitmapId=id
  }
  return bitmap
}
function original(id){
  const photo=photos.find(p=>p.id===id)
  return local.isLocal(photo)?local.original(photo):db.original(id)
}
function clearSources(){
  bitmap?.close();bitmap=null;bitmapId=''
  for(const id of urls.keys())invalidate(id)
  undo.length=redo.length=0
}
async function showLibrary(){
  local.leave();clearSources()
  organization.resetSelection()
  photos=await db.all('photos');selected='';scope='all';mode='grid';compare=zoom=cropping=false
}
async function openLocal(root='',relative=''){
  const opened=await local.open(root,relative)
  if(!opened)return {canceled:true}
  organization.resetSelection()
  clearSources();photos=opened.photos;selected='';scope='all';mode='grid';compare=zoom=cropping=false
  search=$('search').value=''
  if(opened.warnings.length)notice(opened.warnings.map(item=>item.name+': '+item.error).join('; '))
  return {folder:opened.folder,photos:photos.length,warnings:opened.warnings}
}
function thumb(photo) {
  if(!urls.has(photo.id)) urls.set(photo.id,URL.createObjectURL(photo.thumbnail))
  return urls.get(photo.id)
}
function invalidate(id){
  if(urls.has(id)) URL.revokeObjectURL(urls.get(id))
  urls.delete(id)
}
function tile(photo){
  const button=document.createElement('button'), img=new Image(), name=document.createElement('span')
  button.className='tile'+(organization.selection.has(photo.id)?' selected':'')+(selected===photo.id?' active':'')
  button.setAttribute('aria-pressed',organization.selection.has(photo.id))
  button.dataset.photo=photo.id
  button.title=photo.name
  img.src=thumb(photo)
  img.alt=''
  img.loading='lazy'
  name.textContent=photo.name
  button.append(img,name)
  local.observeThumbnail(photo,img,()=>{
    if(photos.find(p=>p.id===photo.id)!==photo)return
    invalidate(photo.id);img.src=thumb(photo)
  })
  return button
}
function syncTiles(container,items){
  const nodes=container.children
  if(nodes.length!==items.length || items.some((p,i)=>nodes[i].dataset.photo!==p.id)){
    container.replaceChildren(...items.map(tile))
  }else{
    items.forEach((p,i)=>{
      const node=nodes[i], url=thumb(p)
      node.classList.toggle('selected',organization.selection.has(p.id))
      node.classList.toggle('active',p.id===selected)
      node.setAttribute('aria-pressed',organization.selection.has(p.id))
      if(node.firstChild.src!==url)node.firstChild.src=url
    })
  }
}
function paintStage(image, edit){
  const recipe=cropping?{...edit,crop:null,aspect:'',turn:0,flip:false}:compare?{}:edit
  const stage=$('stage'), shape=geometry(image,recipe)
  const w=shape.turn%2?shape.height:shape.width, h=shape.turn%2?shape.width:shape.height
  const fit=Math.min((stage.clientWidth-24)/w,(stage.clientHeight-24)/h)*devicePixelRatio
  const edge=zoom?Infinity:Math.max(1,Math.round(Math.max(w,h)*fit))
  const preview=render(image,recipe,edge)
  stage.replaceChildren(preview)
  localToolsUI?.mount(preview,{image,edit:recipe,enabled:!cropping&&!compare})
  if($('histogram-panel').open)drawHistogram($('histogram'),histogram(preview))
  $('stage').classList.toggle('cropping',cropping)
  $('stage').classList.toggle('zoom',zoom)
}
async function draw(){
  local.drawNavigation()
  const list=visible()
  selected=organization.reconcile(list,selected)
  if(!selected) mode='grid'
  const p=active(), detail=mode==='detail'
  $('count').textContent=list.length
  $('heading').textContent=local.state()&&scope==='all'?(local.state().relative==='.'?local.state().root.name:local.state().relative):albums.find(a=>a.id===scope)?.name || ({all:'All photos',picked:'Flagged',trash:'Deleted'})[scope]
  $('gallery').hidden=detail
  $('film').hidden=!detail||!film
  $('stage').hidden=!detail
  document.querySelector('aside').hidden=!detail||p?.deleted
  $('actions').hidden=!p
  $('export').disabled=!p
  $('detail').disabled=!p
  syncTiles($('gallery'),detail?[]:list)
  syncTiles($('film'),detail&&film?list:[])
  if (!list.length && scope==='all' && !search){
    const add=document.createElement('button')
    add.className='empty'
    add.textContent=local.state()?'No photos in this folder — open another folder':'Add photos'
    add.onclick=()=>local.state()?act('local-open'):$('files').click()
    $('gallery').append(add)
  }
  $('albums').replaceChildren(...albums.map(a=>{
    const btn=document.createElement('button')
    btn.dataset.scope=a.id
    btn.textContent=a.name
    return btn
  }))
  document.querySelectorAll('[data-scope]').forEach(btn=>btn.setAttribute('aria-pressed',btn.dataset.scope===scope))
  $('filename').textContent=p?.name || ''
  updateOrganization(snapshot())
  localToolsUI?.sync()
  if(!p) return
  $('rate').value=p.rating
  $('flag').value=p.flag
  $('keywords').value=p.keywords
  $('delete').textContent=p.deleted?'Restore':'Delete'
  $('membership').replaceChildren(option('','Albums'),...albums.map(a=>option(a.id,(p.albums.includes(a.id)?'− ':'＋ ')+a.name)))
  $('info').textContent=p.width+' × '+p.height+' · '+p.name
  $('compare').setAttribute('aria-pressed',compare)
  $('aspect').value=p.edit.aspect || ''
  for(const input of document.querySelectorAll('[data-control]')){
    input.value=p.edit[input.dataset.control] || 0
    input.previousElementSibling.value=input.value
  }
  if(detail) paintStage(await source(p.id),p.edit)
}
function snapshot(){
  const items=visible().map(({thumbnail,...p})=>p)
  return {selected,scope,mode,search,order,compare,film,zoom,albums,photos:items,local:local.state(),selection:[...organization.selection],filters:{...organization.filters},sortDirection:organization.direction,clipboard:organization.clipboard?{source:organization.clipboard.source,keys:organization.clipboard.keys}:null}
}
async function importFiles(files) {
  const failed=[], added=[]
  for (const file of files){
    let image
    try {
      image=await decodePhoto(file)
      const p={id:crypto.randomUUID(),name:file.name,width:image.width,height:image.height,
        added:Date.now(),rating:0,flag:'',keywords:'',deleted:false,albums:albums.some(a=>a.id===scope)?[scope]:[],edit:{},
        thumbnail:await toBlob(render(image,{},240))}
      await db.addPhoto(p,file)
      photos.push(p)
      added.push(p.id)
    }catch(error){failed.push({name:file.name,error:error.message})}
    finally{image?.close()}
  }
  if(added.length){
    if(!albums.some(a=>a.id===scope)) scope='all'
    search=$('search').value=''
    selected=added[0]
    organization.resetSelection()
    organization.selection=new Set([added[0]])
    mode='grid'
  }
  return {added,failed}
}
const groups=Object.assign({},...Object.values(controls))
export {commands} from './agent-protocol.js'

async function replace(p,changes){
  const next={...p,...changes}
  if(changes.edit){
    next.thumbnail=await toBlob(render(await source(p.id),changes.edit,240))
  }
  if(local.isLocal(next))await local.save(next)
  else await db.save('photos',next)
  photos[photos.indexOf(p)]=next
  if(changes.edit) invalidate(p.id)
}
function enumValue(v,values){if(!values.includes(v))throw Error('Expected '+values.join(', '));return v}
function number(v,min,max){
  if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max) throw Error('Expected a number between '+min+' and '+max)
  return v
}
async function applySelection(changes,recordUndo=false){
  const targets=organization.targets(photos)
  if(!targets.length)throw Error('Select at least one photo')
  let completed=0
  try{
    for(const photo of targets){
      await replace(photo,changes(photo))
      if(recordUndo)undo.push({id:photo.id,edit:photo.edit})
      completed++
    }
  }catch(error){
    await draw()
    throw Error('Updated '+completed+' of '+targets.length+' photos: '+error.message)
  }
  if(recordUndo){redo.length=0;compare=false}
}
async function execute(command,args){
  const p=active()
  let result
  switch(command){
    case 'state': return snapshot()
    case 'import': if(local.state())await showLibrary();result=await importFiles(args.files);break
    case 'local-folders': return await globalThis.mygo?.call('Local.Folders')??[]
    case 'local-open': result=await openLocal(args.root||'',args.relative||'');break
    case 'local-browse':
      if(!local.state())throw Error('Open a local folder first')
      result=await openLocal(local.state().root.id,args.relative||'.');break
    case 'library': await showLibrary();break
    case 'select':
      selected=organization.choose(visible(),selected,args);compare=zoom=false;break
    case 'select-many':selected=organization.chooseMany(visible(),args.ids);compare=zoom=false;break
    case 'select-all':selected=organization.chooseMany(visible(),visible().map(p=>p.id));break
    case 'filter':organization.setFilters(args);break
    case 'view': mode=enumValue(args.mode,['grid','detail']);cropping=false;break
    case 'crop-tool': if(!p)throw Error('Select a photo first');mode='detail';compare=zoom=false;cropping=!cropping;break
    case 'search': search=$('search').value=String(args.text);organization.resetSelection();break
    case 'sort': order=$('order').value=enumValue(args.order,['recent','name','rating']);organization.direction=enumValue(args.direction??(order==='name'?'asc':'desc'),['asc','desc']);break
    case 'scope': scope=enumValue(args.id,['all','trash','picked',...albums.map(a=>a.id)]);mode='grid';organization.resetSelection();break
    case 'album':{
      const name=String(args.name??'').trim()
      if(!name) throw Error('Enter an album name')
      const album={id:crypto.randomUUID(),name}
      await db.save('albums',album);albums.push(album);result=album;break
    }
    case 'film': film=!film;break
    case 'album-rename':{
      const album=albums.find(a=>a.id===args.id),name=String(args.name??'').trim()
      if(!album)throw Error('Album not found')
      if(!name)throw Error('Enter an album name')
      const next={...album,name};await db.save('albums',next);albums[albums.indexOf(album)]=next;break
    }
    case 'album-delete':{
      if(!albums.some(a=>a.id===args.id))throw Error('Album not found')
      await db.removeAlbum(args.id)
      albums=albums.filter(a=>a.id!==args.id)
      photos=photos.map(photo=>({...photo,albums:photo.albums.filter(id=>id!==args.id)}))
      if(scope===args.id){scope='all';organization.resetSelection()}
      break
    }
    default:{
      if(!p)throw Error('Select a photo first')
      if(LOCAL_COMMANDS.includes(command)){
        const edit=updateLocalTools(p.edit,command,args)
        await replace(p,{edit});undo.push({id:p.id,edit:p.edit});redo.length=0;compare=cropping=false
        await draw();return snapshot()
      }
      switch(command){
        case 'rate':
          if(!Number.isInteger(args.value))throw Error('Rating must be an integer')
          number(args.value,0,5);await applySelection(()=>({rating:args.value}));break
        case 'flag': enumValue(args.value,['','pick','reject']);await applySelection(()=>({flag:args.value}));break
        case 'keywords': await applySelection(()=>({keywords:String(args.value)}));break
        case 'delete':case 'restore': await applySelection(()=>({deleted:command==='delete'}));break
        case 'membership':{
          const id=enumValue(args.album,albums.map(a=>a.id))
          const remove=organization.targets(photos).every(photo=>photo.albums.includes(id))
          await applySelection(photo=>({albums:remove?photo.albums.filter(a=>a!==id):[...new Set([...photo.albums,id])]}));break
        }
        case 'copy-edits':result=organization.copy(p,args.keys);break
        case 'paste-edits':await applySelection(photo=>({edit:organization.pasted(photo)}),true);break
        case 'version-save':{
          const version=namedVersion(p,args.name)
          await replace(p,{versions:[...(p.versions??[]),version]});result=version;break
        }
        case 'version-restore':{
          const version=findVersion(p,args.id)
          await replace(p,{edit:structuredClone(version.edit)});undo.push({id:p.id,edit:p.edit});redo.length=0;compare=false;break
        }
        case 'version-rename':{
          const version=findVersion(p,args.id),name=String(args.name??'').trim()
          if(!name)throw Error('Enter a version name')
          await replace(p,{versions:p.versions.map(v=>v.id===version.id?{...v,name}:v)});break
        }
        case 'version-delete':findVersion(p,args.id);await replace(p,{versions:p.versions.filter(v=>v.id!==args.id)});break
        case 'edit':case 'reset':{
          let edit={}
          if(command==='edit'){
            const {key,value}=args
            if(Object.hasOwn(groups,key)) number(value,...groups[key])
            else if(key==='crop'){if(value!==null && !validCrop(value))throw Error('Crop rectangle must fit inside the original');cropping=false}
            else if(key==='turn')enumValue(value,[0,1,2,3])
            else if(key==='flip')enumValue(value,[true,false])
            else if(key==='aspect')enumValue(value,['','1','1.5','1.7777777778','0.8'])
            else throw Error('Unknown edit control')
            edit={...p.edit,[key]:value}
          }
          await replace(p,{edit});undo.push({id:p.id,edit:p.edit});redo.length=0;compare=false;break
        }
        case 'undo':case 'redo':{
          const [from,to]=command==='undo'?[undo,redo]:[redo,undo]
          const index=from.findLastIndex(e=>e.id===p.id)
          if(index>=0){await replace(p,{edit:from[index].edit});from.splice(index,1);to.push({id:p.id,edit:p.edit})}
          break
        }
        case 'histogram':return histogram(render(await source(p.id),p.edit,400))
        case 'auto-tone':{
          const exposure=autoExposure(histogram(render(await source(p.id),{},400)))
          await replace(p,{edit:{...p.edit,Exposure:exposure}})
          undo.push({id:p.id,edit:p.edit});redo.length=0;break
        }
        case 'compare':compare=!compare;mode='detail';break
        case 'zoom':zoom=!zoom;mode='detail';break
        case 'export':case 'preview':{
          const format=command==='preview'?'image/png':enumValue(args.format??'image/jpeg',['image/jpeg','image/png','original'])
          if(format==='original')return {blob:(await original(p.id)).file,filename:p.name}
          const max=command==='preview'?number(args.maxSize??1280,1,8192):Infinity
          const canvas=render(await source(p.id),command==='preview'&&compare?{}:p.edit,max)
          return {blob:await toBlob(canvas,format,number(args.quality??0.92,0,1)),filename:p.name.replace(/\.[^.]+$/,'')+(format==='image/png'?'.png':'.jpg')}
        }
        default:throw Error('Unknown command: '+command)
      }
    }
  }
  await draw()
  return result??snapshot()
}
const ready=Promise.all([db.all('photos'),db.all('albums')]).then(async values=>{
  ;[photos,albums]=values
  await draw()
})
export function run(command,args={}){
  const next=queue.then(()=>ready).then(()=>execute(command,args))
  queue=next.catch(()=>{})
  return next
}
let noticeTimer
function notice(text){
  clearTimeout(noticeTimer);$('notice').textContent=text
  noticeTimer=setTimeout(()=>$('notice').textContent='',7000)
}
function act(cmd,args){return run(cmd,args).catch(e=>notice(e.message))}
const localToolContainer=document.createElement('div')
$('reset').before(localToolContainer)
localToolsUI=createLocalToolsUI({container:localToolContainer,run,getActive:active,notify:notice})
async function importUI(files){
  const result=await act('import',{files:[...files]})
  if(result?.failed.length)notice(result.failed.map(f=>f.name+': '+f.error).join(' · '))
}
for(const [group,items] of Object.entries(controls)){
  const details=document.createElement('details'), summary=document.createElement('summary')
  details.open=group==='Light'||group==='Color';summary.textContent=group;details.append(summary)
  for(const [key,[min,max,step]] of Object.entries(items)){
    const label=document.createElement('label'),output=document.createElement('output'),input=document.createElement('input')
    input.type='range';input.min=min;input.max=max;input.step=step;input.value=0;input.dataset.control=key
    input.setAttribute('aria-label',key)
    input.oninput=()=>{
      output.value=input.value
      if(bitmapId===selected){compare=false;paintStage(bitmap,{...active().edit,[key]:Number(input.value)})}
    }
    input.onchange=()=>act('edit',{key,value:Number(input.value)})
    label.append(key,output,input);details.append(label)
  }
  $('adjustments').append(details)
}
for(let i=1;i<=5;i++)$('rate').add(option(i,'★'.repeat(i)))
$('files').accept=PHOTO_ACCEPT
$('crop-tool').onclick=()=>act('crop-tool')
$('clear-crop').onclick=()=>act('edit',{key:'crop',value:null})
cropGesture($('stage'),value=>act('edit',{key:'crop',value}))
$('import').onclick=()=>$('files').click()
$('files').onchange=async e=>{await importUI(e.target.files);e.target.value=''}
document.ondragover=e=>e.preventDefault()
document.ondrop=e=>{e.preventDefault();if(e.dataTransfer.files.length)importUI(e.dataTransfer.files)}
$('search').oninput=e=>act('search',{text:e.target.value})
$('order').onchange=e=>act('sort',{order:e.target.value})
document.querySelector('nav').onclick=e=>{const btn=e.target.closest('[data-scope]');if(btn)act('scope',{id:btn.dataset.scope})}
for(const id of ['gallery','film']){
  $(id).onclick=e=>{const btn=e.target.closest('[data-photo]');if(btn)act('select',{id:btn.dataset.photo,toggle:e.ctrlKey||e.metaKey,range:e.shiftKey})}
  $(id).ondblclick=e=>{if(e.target.closest('[data-photo]'))act('view',{mode:'detail'})}
}
$('grid').onclick=()=>act('view',{mode:'grid'})
$('detail').onclick=()=>act('view',{mode:'detail'})
$('stage').onclick=()=>{if(!cropping)act('zoom')}
$('rate').onchange=e=>act('rate',{value:Number(e.target.value)})
$('flag').onchange=e=>act('flag',{value:e.target.value})
$('keywords').onchange=e=>act('keywords',{value:e.target.value})
$('delete').onclick=()=>act(active()?.deleted?'restore':'delete')
$('membership').onchange=e=>act('membership',{album:e.target.value})
$('compare').onclick=()=>act('compare')
$('auto-tone').onclick=()=>act('auto-tone')
$('histogram-panel').ontoggle=()=>{
  const canvas=$('stage').querySelector('canvas')
  if($('histogram-panel').open&&canvas)drawHistogram($('histogram'),histogram(canvas))
}
$('reset').onclick=()=>act('reset')
for(const [id,delta] of [['left',3],['right',1]])$(id).onclick=()=>act('edit',{key:'turn',value:((active().edit.turn||0)+delta)%4})
$('flip').onclick=()=>act('edit',{key:'flip',value:!active().edit.flip})
$('aspect').onchange=e=>act('edit',{key:'aspect',value:e.target.value})
$('new-album').onclick=()=>{$('album-name').value='';$('album-dialog').showModal()}
$('album-dialog').onclose=e=>{if(e.target.returnValue==='ok')act('album',{name:$('album-name').value});e.target.returnValue=''}
$('export').onclick=()=>$('export-dialog').showModal()
$('format').onchange=e=>{$('quality').disabled=e.target.value!=='image/jpeg'}
$('export-dialog').onclose=async e=>{
  const accepted=e.target.returnValue==='ok'
  e.target.returnValue=''
  if(!accepted)return
  try{const {blob,filename}=await run('export',{format:$('format').value,quality:$('quality').value/100});await saveExport(blob,filename)}
  catch(err){notice(err.message)}
}
document.onkeydown=e=>{
  if(document.querySelector('dialog[open]')||e.target.matches('input,select,textarea'))return
  const key=e.key.toLowerCase(), mod=e.ctrlKey||e.metaKey
  if(mod&&key==='a')act('select-all')
  else if(mod&&key==='c')act('copy-edits')
  else if(mod&&key==='v')act('paste-edits')
  else if(mod&&key==='z')act(e.shiftKey?'redo':'undo')
  else if(mod&&key==='f')$('search').focus()
  else if(mod&&e.shiftKey&&key==='i')$('files').click()
  else if(!mod&&key==='e'&&e.shiftKey)$('export').click()
  else if(!mod&&['e','d','g'].includes(key))act('view',{mode:key==='g'?'grid':'detail'})
  else if(!mod&&/^[0-5]$/.test(key))act('rate',{value:Number(key)})
  else if(!mod&&['z','u','x'].includes(key))act('flag',{value:{z:'pick',u:'',x:'reject'}[key]})
  else if(!mod&&key==='delete')$('delete').click()
  else if(!mod&&key==='\\')act('compare')
  else if(!mod&&key==='c')act('crop-tool')
  else if(!mod&&key==='/')act('film')
  else if(!mod&&key===' ')act('zoom')
  else if(!mod&&['arrowleft','arrowright'].includes(key)){
    const list=visible(),i=list.findIndex(p=>p.id===selected)+(key==='arrowright'?1:-1)
    if(list[i])act('select',{id:list[i].id})
  }else return
  e.preventDefault()
}
local.mount((command,args)=>act(command,args),notice)
ready.catch(e=>notice(e.message))
updateOrganization=mountOrganization(act)
