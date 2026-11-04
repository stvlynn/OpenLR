// Crop rectangles are fractions of the optics-corrected base canvas, before
// reflection and 90-degree rotation. Its bounds retain the original dimensions.
export function geometry(image,edit={},maxSize=Infinity){
  const box=edit.crop || {x:0,y:0,w:1,h:1}
  const boxW=box.w*image.width, boxH=box.h*image.height
  const ratio=Number(edit.aspect)||boxW/boxH
  const w=Math.min(boxW,boxH*ratio),h=w/ratio
  const scale=Math.min(1,maxSize/Math.max(w,h))
  return {x:box.x*image.width+(boxW-w)/2,y:box.y*image.height+(boxH-h)/2,w,h,
    width:Math.max(1,Math.round(w*scale)),height:Math.max(1,Math.round(h*scale)),
    turn:edit.turn||0,flip:Boolean(edit.flip)}
}
export function validCrop(box){
  return box && ['x','y','w','h'].every(key=>Number.isFinite(box[key])) &&
    box.x>=0 && box.y>=0 && box.w>0 && box.h>0 && box.x+box.w<=1.00000001 && box.y+box.h<=1.00000001
}
export function cropGesture(stage,commit){
  let origin=null, bounds=null, frame=null
  const point=e=>({x:Math.min(1,Math.max(0,(e.clientX-bounds.left)/bounds.width)),
                   y:Math.min(1,Math.max(0,(e.clientY-bounds.top)/bounds.height))})
  function rect(e){
    const end=point(e)
    return {x:Math.min(origin.x,end.x),y:Math.min(origin.y,end.y),w:Math.abs(origin.x-end.x),h:Math.abs(origin.y-end.y)}
  }
  function cancel(){origin=null;frame?.remove();frame=null}
  stage.addEventListener('pointerdown',e=>{
    if(!stage.classList.contains('cropping')||e.target.tagName!=='CANVAS')return
    bounds=e.target.getBoundingClientRect();origin=point(e)
    frame=document.createElement('div');frame.className='crop-frame';document.body.append(frame)
    stage.setPointerCapture(e.pointerId);e.preventDefault()
  })
  stage.addEventListener('pointermove',e=>{
    if(!origin)return
    const r=rect(e)
    Object.assign(frame.style,{left:bounds.left+r.x*bounds.width+'px',top:bounds.top+r.y*bounds.height+'px',width:r.w*bounds.width+'px',height:r.h*bounds.height+'px'})
  })
  stage.addEventListener('pointerup',e=>{
    if(!origin)return
    const r=rect(e);cancel()
    if(r.w*bounds.width>=2 && r.h*bounds.height>=2)commit(r)
  })
  stage.addEventListener('pointercancel',cancel)
}
