import {geometry} from './geometry.js'
import {LOCAL_CONTROLS,localWeight} from './local-tools.js'
import {compileOptics,renderOpticsSource} from './optics.js'
import {AI_TARGETS} from './ai-models.js'
import {decodeSoftMask} from './soft-mask.js'

const clamp=v=>Math.max(0,Math.min(1,v))
export function viewToOriginal(point,image,edit={}){
  const g=geometry(image,edit),turn=((g.turn%4)+4)%4
  let {x,y}=point
  if(turn===1)[x,y]=[y,1-x]
  if(turn===2)[x,y]=[1-x,1-y]
  if(turn===3)[x,y]=[1-y,x]
  if(g.flip)x=1-x
  const corrected={x:(g.x+x*g.w)/image.width,y:(g.y+y*g.h)/image.height}
  const mapping=compileOptics(image,edit.optics),original=mapping.toOriginal(corrected)
  if(mapping.active&&(original.x<0||original.y<0||original.x>1||original.y>1))return null
  return {x:clamp(original.x),y:clamp(original.y)}
}
export function originalToView(point,image,edit={}){
  const g=geometry(image,edit),turn=((g.turn%4)+4)%4
  const corrected=compileOptics(image,edit.optics).fromOriginal(point)
  if(!corrected)return {x:NaN,y:NaN}
  let x=(corrected.x*image.width-g.x)/g.w,y=(corrected.y*image.height-g.y)/g.h
  if(g.flip)x=1-x
  if(turn===1)[x,y]=[1-y,x]
  if(turn===2)[x,y]=[1-x,1-y]
  if(turn===3)[x,y]=[y,1-x]
  return {x,y}
}
function element(tag,attributes={},text){
  const node=document.createElement(tag)
  for(const [key,value]of Object.entries(attributes))node.setAttribute(key,value)
  if(text)node.textContent=text
  return node
}
export function createLocalToolsUI({container,run,getActive,notify}){
  const panel=element('details',{class:'local-tools'}),heading=element('summary',{},'Masks & local repair')
  const mode=element('select',{'aria-label':'Local tool'}),tools=[['off','Navigate'],['linear','Linear gradient'],['radial','Radial gradient'],['brush','Brush mask'],['clone','Clone'],['heal','Heal texture']]
  tools.forEach(([value,label])=>mode.append(element('option',{value},label)))
  const list=element('select',{'aria-label':'Local edit selection'}),status=element('p',{class:'tool-hint'},'Choose a tool, then drag on the image.')
  const choose=element('button',{type:'button'},'Choose repair source'),remove=element('button',{type:'button'},'Remove local edit')
  const invert=element('input',{type:'checkbox','aria-label':'Invert mask'}),enabled=element('input',{type:'checkbox','aria-label':'Enable local edit'})
  const sliders={}
  const field=(text,node)=>{const label=element('label');label.append(text,node);panel.append(label);return label}
  panel.append(heading);field('Tool ',mode);field('Edit ',list)
  const aiTarget=element('select',{'aria-label':'AI mask target'}),generate=element('button',{type:'button'},'Generate AI mask')
  for(const target of AI_TARGETS)aiTarget.append(element('option',{value:target},target[0].toUpperCase()+target.slice(1)))
  field('AI selection ',aiTarget);panel.append(generate,element('p',{class:'tool-hint'},'Runs locally. Sky downloads a 172 MB model once and caches it; photos stay on this device.'))
  generate.onclick=async()=>{
    generate.disabled=true;status.textContent=aiTarget.value==='sky'?'Preparing sky model and selection…':'Generating selection…'
    try{
      await run('ai-mask',{target:aiTarget.value,photoId:getActive()?.id,adjustments:Object.fromEntries(Object.keys(LOCAL_CONTROLS).map(key=>[key,Number(sliders[key].value)]))})
      const item=getActive()?.edit.localTools?.masks?.at(-1)
      if(item){list.value=item.id;mode.value='off';sync();status.textContent='Generated '+aiTarget.value+' selection. Adjust, invert or disable it below.'}
    }catch(error){status.textContent=error.message;notify(error.message)}finally{generate.disabled=false}
  }
  for(const [name,[min,max,step,initial]]of Object.entries({radius:[0.001,0.5,0.001,0.05],feather:[0,1,0.01,0.5],opacity:[0,1,0.01,1],...LOCAL_CONTROLS})){
    const defaultValue=initial??(name==='Exposure'?1:0)
    const slider=element('input',{type:'range',min,max,step,value:defaultValue,'aria-label':'Local '+name}),output=element('output',{},String(defaultValue))
    const label=field(name[0].toUpperCase()+name.slice(1)+' ',output);label.append(slider);sliders[name]=slider
    slider.oninput=()=>{output.value=slider.value}
    slider.onchange=()=>{
      const item=selectedItem()
      if(!item)return
      const isAdjustment=Object.hasOwn(LOCAL_CONTROLS,name),isRepair=['clone','heal'].includes(item.type)
      if((isAdjustment&&isRepair)||(name==='radius'&&!['brush','clone','heal'].includes(item.type)))return
      commit(isRepair?'repair.update':'mask.update',{id:item.id,changes:isAdjustment?{adjustments:{[name]:Number(slider.value)}}:{[name]:Number(slider.value)}})
    }
  }
  field('Invert ',invert);field('Enabled ',enabled)
  panel.append(choose,remove,status);container.append(panel)
  let source=null,picking=false,asset='',mounted,cleanup=()=>{},draft=null
  const selectedItem=()=>{const local=getActive()?.edit.localTools;return [...(local?.masks??[]),...(local?.repairs??[])].find(item=>item.id===list.value)}
  const commit=(command,args)=>run(command,{...args,photoId:args.photoId??getActive()?.id}).then(()=>{
    if(command.endsWith('.add')){const group=command.startsWith('mask')?'masks':'repairs';list.value=getActive()?.edit.localTools?.[group]?.at(-1)?.id??'';sync()}
  }).catch(error=>notify(error.message))
  function sync(){
    const photo=getActive(),local=photo?.edit.localTools??{},previous=list.value
    if(asset!==photo?.id){asset=photo?.id;source=null;draft=null}
    const items=[...(local.masks??[]),...(local.repairs??[])]
    list.replaceChildren(element('option',{value:''},'New stroke / gradient'),...items.map((item,index)=>element('option',{value:item.id},(index+1)+'. '+(item.type==='semantic'?(item.provenance?.target??'semantic')+' (AI)':item.type)+(item.enabled===false?' (off)':''))))
    if(items.some(item=>item.id===previous))list.value=previous
    const item=selectedItem();remove.disabled=!item;invert.disabled=!item||['clone','heal'].includes(item.type);enabled.disabled=!item
    invert.checked=item?.invert??false;enabled.checked=item?.enabled??true
    for(const [name,input]of Object.entries(sliders)){
      const isAdjustment=Object.hasOwn(LOCAL_CONTROLS,name),isRepair=item&&['clone','heal'].includes(item.type)
      input.disabled=Boolean((isAdjustment&&isRepair)||(name==='radius'&&item&&!['brush','clone','heal'].includes(item.type))||(name==='feather'&&['linear','semantic'].includes(item?.type??mode.value)))
      if(item){input.value=isAdjustment?item.adjustments?.[name]??0:item[name]??input.value;input.previousElementSibling.value=input.value}
    }
    choose.hidden=!['clone','heal'].includes(mode.value)
    if(mounted)drawOverlay()
  }
  list.onchange=sync
  mode.onchange=()=>{picking=false;draft=null;list.value='';sync();status.textContent=['clone','heal'].includes(mode.value)?'Alt-click or choose a source, then drag the target.':'Drag to create a new '+mode.options[mode.selectedIndex].text+'.';if(mounted)mounted.canvas.style.cursor=mode.value==='off'?'zoom-in':'crosshair'}
  choose.onclick=()=>{picking=true;status.textContent='Click the image to choose the source.'}
  remove.onclick=()=>{const item=selectedItem();if(item)commit(['clone','heal'].includes(item.type)?'repair.remove':'mask.remove',{id:item.id})}
  invert.onchange=()=>{const item=selectedItem();if(item)commit('mask.update',{id:item.id,changes:{invert:invert.checked}})}
  enabled.onchange=()=>{const item=selectedItem();if(item)commit(['clone','heal'].includes(item.type)?'repair.update':'mask.update',{id:item.id,changes:{enabled:enabled.checked}})}
  function svgNode(tag,attributes){const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attributes))node.setAttribute(k,v);return node}
  function drawOverlay(){
    if(!mounted)return
    const {canvas,overlay,image,edit}=mounted,bounds=canvas.getBoundingClientRect()
    Object.assign(overlay.style,{left:bounds.left+'px',top:bounds.top+'px',width:bounds.width+'px',height:bounds.height+'px'})
    overlay.setAttribute('viewBox','0 0 '+bounds.width+' '+bounds.height);overlay.replaceChildren()
    const project=p=>{const q=originalToView(p,image,edit);return {x:q.x*bounds.width,y:q.y*bounds.height}}
    const path=points=>{let connected=false;return points.map(p=>{const q=project(p);if(!Number.isFinite(q.x)||!Number.isFinite(q.y)){connected=false;return ''}const result=(connected?'L':'M')+q.x+' '+q.y;connected=true;return result}).join(' ')}
    const circle=p=>{const q=project(p);if(Number.isFinite(q.x)&&Number.isFinite(q.y))overlay.append(svgNode('circle',{cx:q.x,cy:q.y,r:5,fill:'none',stroke:'#59d9ff','stroke-width':2}))}
    const tool=draft||selectedItem()
    if(tool?.type==='semantic'||(tool?.points&&compileOptics(image,edit.optics).active)){
      const raster=tool.raster??{width:Math.max(1,Math.round(384*image.width/Math.max(image.width,image.height))),height:Math.max(1,Math.round(384*image.height/Math.max(image.width,image.height)))},mask=tool.type==='semantic'?decodeSoftMask(raster):null,small=document.createElement('canvas');small.width=raster.width;small.height=raster.height
      const context=small.getContext('2d'),pixels=context.createImageData(raster.width,raster.height)
      for(let i=0;i<raster.width*raster.height;i++){
        pixels.data[i*4]=255
        pixels.data[i*4+3]=mask?(tool.invert?255-mask[i]:mask[i]):255*localWeight(tool,(i%raster.width+0.5)/raster.width,(Math.floor(i/raster.width)+0.5)/raster.height,image.width,image.height)
      }
      context.putImageData(pixels,0,0)
      const view=document.createElement('canvas');view.width=Math.max(1,Math.round(bounds.width));view.height=Math.max(1,Math.round(bounds.height))
      const g=geometry(image,edit),ctx=view.getContext('2d'),w=g.turn%2?view.height:view.width,h=g.turn%2?view.width:view.height
      ctx.translate(view.width/2,view.height/2);ctx.rotate(g.turn*Math.PI/2);ctx.scale(g.flip?-1:1,1)
      const corrected=renderOpticsSource(small,{...edit.optics,profileTCA:false,redScale:0,blueScale:0},image)
      ctx.drawImage(corrected,g.x/image.width*raster.width,g.y/image.height*raster.height,g.w/image.width*raster.width,g.h/image.height*raster.height,-w/2,-h/2,w,h)
      overlay.append(svgNode('image',{href:view.toDataURL(),x:0,y:0,width:bounds.width,height:bounds.height,opacity:0.3,preserveAspectRatio:'none'}))
    }else if(tool?.type==='linear')overlay.append(svgNode('path',{d:path([tool.start,tool.end]),stroke:'#ffb15c','stroke-width':2,fill:'none'}))
    else if(tool?.type==='radial'){
      const points=Array.from({length:65},(_,i)=>({x:tool.center.x+Math.cos(i*Math.PI/32)*tool.rx,y:tool.center.y+Math.sin(i*Math.PI/32)*tool.ry}))
      overlay.append(svgNode('path',{d:path(points),stroke:'#ffb15c','stroke-width':2,fill:'none'}))
    }else if(tool?.points){
      const g=geometry(image,edit),scale=Math.min(bounds.width/(g.turn%2?g.h:g.w),bounds.height/(g.turn%2?g.w:g.h))
      overlay.append(svgNode('path',{d:path(tool.points.length===1?[tool.points[0],{x:tool.points[0].x+0.00001,y:tool.points[0].y}]:tool.points),stroke:'#ffb15c','stroke-width':Math.max(2,tool.radius*Math.min(image.width,image.height)*scale*2),'stroke-linecap':'round','stroke-linejoin':'round',opacity:0.45,fill:'none'}))
    }
    if(source)circle(source)
  }
  function mount(canvas,{image,edit,enabled:available=true}){
    cleanup();mounted=null
    if(!available)return
    const overlay=svgNode('svg',{'aria-hidden':'true',class:'local-overlay'})
    Object.assign(overlay.style,{position:'fixed',pointerEvents:'none',zIndex:5,overflow:'hidden'})
    document.body.append(overlay);mounted={canvas,overlay,image,edit}
    canvas.style.cursor=mode.value==='off'?'zoom-in':'crosshair'
    let gesture=null
    const point=event=>{const r=canvas.getBoundingClientRect();return viewToOriginal({x:clamp((event.clientX-r.left)/r.width),y:clamp((event.clientY-r.top)/r.height)},image,edit)}
    const down=event=>{
      if(mode.value==='off'||event.button!==0)return
      event.preventDefault();event.stopPropagation();canvas.setPointerCapture(event.pointerId)
      const p=point(event),repair=['clone','heal'].includes(mode.value)
      if(!p){status.textContent='Choose a point inside the corrected source image.';return}
      if(repair&&(picking||event.altKey||!source)){source=p;picking=false;status.textContent='Source selected. Drag the target to apply.';drawOverlay();return}
      gesture={id:getActive()?.id,start:p,points:[p],pointerId:event.pointerId,type:mode.value}
      updateDraft(p)
    }
    function updateDraft(end){
      const base={type:gesture.type,opacity:Number(sliders.opacity.value),feather:Number(sliders.feather.value)}
      if(base.type==='linear')draft={...base,start:gesture.start,end}
      else if(base.type==='radial')draft={...base,center:gesture.start,rx:Math.max(0.00001,Math.abs(end.x-gesture.start.x)),ry:Math.max(0.00001,Math.abs(end.y-gesture.start.y))}
      else draft={...base,points:[...gesture.points],radius:Number(sliders.radius.value),...(['clone','heal'].includes(base.type)?{source}:{})}
      if(!['clone','heal'].includes(base.type))draft.adjustments=Object.fromEntries(Object.keys(LOCAL_CONTROLS).map(k=>[k,Number(sliders[k].value)]))
      drawOverlay()
    }
    const move=event=>{
      if(!gesture||event.pointerId!==gesture.pointerId)return
      event.preventDefault();event.stopPropagation()
      const p=point(event),previous=gesture.points.at(-1)
      if(!p)return
      if(Math.hypot(p.x-previous.x,p.y-previous.y)>0.001)gesture.points.push(p)
      updateDraft(p)
    }
    const up=event=>{
      if(!gesture||event.pointerId!==gesture.pointerId)return
      event.preventDefault();event.stopPropagation()
      const end=point(event)
      if(!end){gesture=draft=null;drawOverlay();return}
      updateDraft(end);const tool=draft,current=gesture;gesture=draft=null
      if(current.id===getActive()?.id){
        const repair=['clone','heal'].includes(tool.type)
        if(tool.type==='linear'&&Math.hypot(tool.end.x-tool.start.x,tool.end.y-tool.start.y)<0.002){drawOverlay();return}
        commit(repair?'repair.add':'mask.add',{[repair?'repair':'mask']:tool})
      }
    }
    const cancel=()=>{gesture=draft=null;drawOverlay()}
    const click=event=>{if(mode.value!=='off'){event.stopPropagation();event.preventDefault()}}
    for(const [type,handler]of Object.entries({pointerdown:down,pointermove:move,pointerup:up,pointercancel:cancel,click}))canvas.addEventListener(type,handler)
    const observer=new ResizeObserver(drawOverlay);observer.observe(canvas)
    window.addEventListener('scroll',drawOverlay,true);window.addEventListener('resize',drawOverlay)
    cleanup=()=>{observer.disconnect();overlay.remove();for(const [type,handler]of Object.entries({pointerdown:down,pointermove:move,pointerup:up,pointercancel:cancel,click}))canvas.removeEventListener(type,handler);window.removeEventListener('scroll',drawOverlay,true);window.removeEventListener('resize',drawOverlay)}
    drawOverlay()
  }
  sync()
  function setMode(value){mode.value=value;mode.onchange();panel.open=value!=='off'}
  return {sync,mount,setMode,active:()=>mode.value!=='off',deactivate:()=>setMode('off'),panel}
}
