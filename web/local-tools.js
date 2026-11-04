// Local recipes always use fractions of the decoded, oriented original image.
export const LOCAL_CONTROLS={Exposure:[-5,5,0.05],Contrast:[-100,100,1],Saturation:[-100,100,1]}
export const LOCAL_COMMANDS=['mask.add','mask.update','mask.remove','repair.add','repair.update','repair.remove']
const clamp=(v,min=0,max=1)=>Math.min(max,Math.max(min,v))
function scalar(value,min,max,name){
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(name+' must be between '+min+' and '+max)
  return value
}
function point(value,name){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['x','y'].includes(k)))throw Error(name+' must be an x/y point')
  return {x:scalar(value.x,0,1,name+'.x'),y:scalar(value.y,0,1,name+'.y')}
}
function points(value){
  if(!Array.isArray(value)||!value.length)throw Error('A brush needs at least one point')
  return value.map((p,i)=>point(p,'points['+i+']'))
}
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected a tool object');return value}
export function validateLocalChanges(kind,changes){
  object(changes)
  const allowed=kind==='mask'?['enabled','opacity','feather','start','end','center','rx','ry','points','radius','invert','adjustments']:['enabled','opacity','feather','source','points','radius']
  if(Object.keys(changes).some(key=>!allowed.includes(key)))throw Error('Unknown local tool change')
  for(const [key,value]of Object.entries(changes)){
    if(['enabled','invert'].includes(key)){if(typeof value!=='boolean')throw Error(key+' must be boolean')}
    else if(['start','end','center','source'].includes(key))point(value,key)
    else if(key==='points')points(value)
    else if(key==='adjustments'){
      for(const [name,v]of Object.entries(object(value))){if(!Object.hasOwn(LOCAL_CONTROLS,name))throw Error('Unknown local adjustment: '+name);scalar(v,...LOCAL_CONTROLS[name].slice(0,2),name)}
    }else scalar(value,['radius','rx','ry'].includes(key)?0.00001:0,1,key)
  }
  return changes
}
export function validateLocalTool(kind,value){
  object(value)
  const repair=kind==='repair', types=repair?['clone','heal']:['linear','radial','brush']
  if(!types.includes(value.type))throw Error('Expected tool type '+types.join(', '))
  const allowed=['id','type','enabled','opacity','feather',...(repair?['source','points','radius']:['adjustments','invert',...(value.type==='linear'?['start','end']:value.type==='radial'?['center','rx','ry']:['points','radius'])])]
  if(Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Unknown local tool property')
  const result={type:value.type,enabled:value.enabled??true,opacity:scalar(value.opacity??1,0,1,'opacity'),feather:scalar(value.feather??0.5,0,1,'feather')}
  if(typeof result.enabled!=='boolean')throw Error('enabled must be boolean')
  if(value.id!==undefined){if(typeof value.id!=='string'||!value.id)throw Error('Expected a tool ID');result.id=value.id}
  if(repair||value.type==='brush'){result.points=points(value.points);result.radius=scalar(value.radius??0.05,0.00001,1,'radius')}
  if(repair)result.source=point(value.source,'source')
  else{
    result.invert=value.invert??false
    if(typeof result.invert!=='boolean')throw Error('invert must be boolean')
    result.adjustments={}
    for(const [key,v]of Object.entries(object(value.adjustments??{}))){
      if(!Object.hasOwn(LOCAL_CONTROLS,key))throw Error('Unknown local adjustment: '+key)
      result.adjustments[key]=scalar(v,...LOCAL_CONTROLS[key].slice(0,2),key)
    }
    if(value.type==='linear'){
      result.start=point(value.start,'start');result.end=point(value.end,'end')
      if(Math.hypot(result.end.x-result.start.x,result.end.y-result.start.y)<1e-8)throw Error('Gradient endpoints must differ')
    }else if(value.type==='radial'){
      result.center=point(value.center,'center');result.rx=scalar(value.rx,0.00001,1,'rx');result.ry=scalar(value.ry,0.00001,1,'ry')
    }
  }
  return result
}
export function updateLocalTools(edit,command,args){
  const [kind,action]=command.split('.'),collection=kind==='mask'?'masks':'repairs'
  if(!LOCAL_COMMANDS.includes(command))throw Error('Unknown local tool command')
  const local={masks:[...(edit.localTools?.masks??[])],repairs:[...(edit.localTools?.repairs??[])]},list=local[collection]
  if(action==='add'){
    const item=validateLocalTool(kind,args[kind])
    item.id=crypto.randomUUID();list.push(item)
  }else{
    const index=list.findIndex(item=>item.id===args.id)
    if(index<0)throw Error('Local tool was not found')
    if(action==='remove')list.splice(index,1)
    else{
      const changes=validateLocalChanges(kind,args.changes)
      if(Object.hasOwn(changes,'id'))throw Error('A local tool ID cannot be changed')
      const merged={...list[index],...changes}
      if(kind==='mask')merged.adjustments={...list[index].adjustments,...changes.adjustments}
      list[index]=validateLocalTool(kind,merged)
      // Repair recipes have no adjustment fields.
    }
  }
  return {...edit,localTools:local}
}
function segmentDistance(x,y,a,b,width,height,short){
  const ax=a.x*width/short,ay=a.y*height/short,bx=b.x*width/short,by=b.y*height/short
  x*=width/short;y*=height/short
  const dx=bx-ax,dy=by-ay,t=clamp(((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1))
  return Math.hypot(x-ax-t*dx,y-ay-t*dy)
}
function falloff(distance,feather){
  if(distance>=1)return 0
  if(!feather||distance<=1-feather)return 1
  const t=(1-distance)/feather
  return t*t*(3-2*t)
}
export function localWeight(tool,x,y,width,height){
  let weight
  if(tool.type==='linear'){
    const dx=(tool.end.x-tool.start.x)*width,dy=(tool.end.y-tool.start.y)*height
    weight=clamp(((x-tool.start.x)*width*dx+(y-tool.start.y)*height*dy)/(dx*dx+dy*dy))
  }else if(tool.type==='radial')weight=falloff(Math.hypot((x-tool.center.x)/tool.rx,(y-tool.center.y)/tool.ry),tool.feather)
  else{
    const short=Math.min(width,height),path=tool.points
    let distance=Infinity
    for(let i=0;i<path.length;i++)distance=Math.min(distance,segmentDistance(x,y,path[i],path[Math.max(0,i-1)],width,height,short))
    weight=falloff(distance/tool.radius,tool.feather)
  }
  return (tool.invert?1-weight:weight)*tool.opacity
}
function bounds(tool,width,height){
  if(tool.type==='linear'||tool.invert)return {x0:0,y0:0,x1:width,y1:height}
  let left,right,top,bottom
  if(tool.type==='radial'){
    left=(tool.center.x-tool.rx)*width;right=(tool.center.x+tool.rx)*width
    top=(tool.center.y-tool.ry)*height;bottom=(tool.center.y+tool.ry)*height
  }else{
    const radius=tool.radius*Math.min(width,height)
    left=Infinity;right=-Infinity;top=Infinity;bottom=-Infinity
    for(const p of tool.points){left=Math.min(left,p.x*width-radius);right=Math.max(right,p.x*width+radius);top=Math.min(top,p.y*height-radius);bottom=Math.max(bottom,p.y*height+radius)}
  }
  return {x0:clamp(Math.floor(left-0.5),0,width),x1:clamp(Math.ceil(right+0.5),0,width),y0:clamp(Math.floor(top-0.5),0,height),y1:clamp(Math.ceil(bottom+0.5),0,height)}
}
const linear=Float64Array.from({length:256},(_,i)=>{const v=i/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4})
const encode=v=>255*(v<=0.0031308?12.92*v:1.055*v**(1/2.4)-0.055)
function adjust(data,index,settings,weight){
  if(!weight)return
  const gain=2**(settings.Exposure||0),contrast=2**((settings.Contrast||0)/100),sat=1+(settings.Saturation||0)/100
  const channels=[linear[data[index]]*gain,linear[data[index+1]]*gain,linear[data[index+2]]*gain]
  const lum=channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722
  const tone=(lum-0.18)*contrast+0.18
  for(let c=0;c<3;c++)data[index+c]=data[index+c]*(1-weight)+clamp(encode(tone+(channels[c]-lum)*sat*contrast),0,255)*weight
}
function sample(data,width,height,x,y){
  // Coordinates are pixel centers; a source beyond the image is never edge-smeared.
  if(x<0||y<0||x>width-1||y>height-1)return null
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),fx=x-x0,fy=y-y0
  const out=[0,0,0,0]
  for(const [px,py,w]of [[x0,y0,(1-fx)*(1-fy)],[x1,y0,fx*(1-fy)],[x0,y1,(1-fx)*fy],[x1,y1,fx*fy]]){
    const i=(py*width+px)*4,alpha=data[i+3]/255
    for(let c=0;c<3;c++)out[c]+=data[i+c]*alpha*w
    out[3]+=alpha*w
  }
  for(let c=0;c<3;c++)out[c]=out[3]?out[c]/out[3]:0
  out[3]*=255
  return out
}
export function applyLocalTools(pixels,local={}){
  const {data,width,height}=pixels
  // Read the immutable pre-stroke buffer and defer writes to a small destination patch.
  // This avoids clone feedback and avoids a full-frame copy for every repair.
  for(const tool of local.repairs??[]){
    if(tool.enabled===false||!tool.opacity)continue
    const base=data,dx=(tool.source.x-tool.points[0].x)*width,dy=(tool.source.y-tool.points[0].y)*height
    const {x0,y0,x1,y1}=bounds(tool,width,height),patchWidth=x1-x0,patch=new Uint8ClampedArray(patchWidth*(y1-y0)*4)
    for(let y=y0;y<y1;y++)patch.set(base.subarray((y*width+x0)*4,(y*width+x1)*4),(y-y0)*patchWidth*4)
    const mean=[0,0,0],sourceMean=[0,0,0];let total=0
    if(tool.type==='heal')for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const weight=localWeight(tool,(x+0.5)/width,(y+0.5)/height,width,height)
      if(!weight)continue
      const from=sample(base,width,height,x+dx,y+dy),i=(y*width+x)*4
      if(!from||!from[3]||!base[i+3])continue
      total+=weight
      for(let c=0;c<3;c++){mean[c]+=base[i+c]*weight;sourceMean[c]+=from[c]*weight}
    }
    const correction=mean.map((v,c)=>total?(v-sourceMean[c])/total:0)
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const weight=localWeight(tool,(x+0.5)/width,(y+0.5)/height,width,height)
      if(!weight)continue
      const from=sample(base,width,height,x+dx,y+dy)
      if(!from)continue
      const i=(y*width+x)*4,j=((y-y0)*patchWidth+x-x0)*4,alpha=(base[i+3]*(1-weight)+from[3]*weight)/255
      for(let c=0;c<3;c++)patch[j+c]=alpha?((base[i+c]*base[i+3]*(1-weight)+clamp(from[c]+correction[c],0,255)*from[3]*weight)/(alpha*255)):0
      patch[j+3]=alpha*255
    }
    for(let y=y0;y<y1;y++)data.set(patch.subarray((y-y0)*patchWidth*4,(y-y0+1)*patchWidth*4),(y*width+x0)*4)
  }
  for(const tool of local.masks??[]){
    if(tool.enabled===false||!tool.opacity)continue
    const {x0,y0,x1,y1}=bounds(tool,width,height)
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)adjust(data,(y*width+x)*4,tool.adjustments,localWeight(tool,(x+0.5)/width,(y+0.5)/height,width,height))
  }
  return pixels
}
export function renderLocalSource(image,local,maxEdge=Infinity){
  if(![...(local?.masks??[]),...(local?.repairs??[])].some(tool=>tool.enabled!==false&&tool.opacity))return image
  const canvas=document.createElement('canvas'),scale=Math.min(1,maxEdge/Math.max(image.width,image.height))
  canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale))
  const context=canvas.getContext('2d',{willReadFrequently:true})
  context.drawImage(image,0,0,canvas.width,canvas.height)
  context.putImageData(applyLocalTools(context.getImageData(0,0,canvas.width,canvas.height),local),0,0)
  return canvas
}
