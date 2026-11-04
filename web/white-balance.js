// Solve the red/blue and green/magenta gains against a neutral patch in linear light.
export function neutralBalance(image,x,y){
  const canvas=document.createElement('canvas')
  canvas.width=canvas.height=5
  const ctx=canvas.getContext('2d',{willReadFrequently:true})
  const w=Math.min(5,image.width),h=Math.min(5,image.height)
  ctx.drawImage(image,Math.min(image.width-w,Math.max(0,x*image.width-w/2)),
    Math.min(image.height-h,Math.max(0,y*image.height-h/2)),w,h,0,0,5,5)
  const data=ctx.getImageData(0,0,5,5).data,sums=[0,0,0]
  for(let i=0;i<data.length;i+=4)for(let c=0;c<3;c++){
    const v=data[i+c]/255
    sums[c]+=(v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*data[i+3]/255
  }
  if(Math.min(...sums)<=0)throw Error('Choose a neutral midtone')
  const [r,g,b]=sums,clamp=v=>Math.round(Math.min(100,Math.max(-100,v)))
  return {Temperature:clamp(50*Math.log2(b/r)),Tint:clamp(200*Math.log2(g/Math.sqrt(r*b)))}
}
