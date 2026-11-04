import {geometry} from './geometry.js'
import {renderLocalSource} from './local-tools.js'
import {createMixer, mixerControls, spatialEffects, toneCurve} from './color.js'
export const controls = {
  Light: {Exposure:[-5,5,0.05], Contrast:[-100,100,1], Highlights:[-100,100,1], Shadows:[-100,100,1], Whites:[-100,100,1], Blacks:[-100,100,1]},
  Color: {Temperature:[-100,100,1], Tint:[-100,100,1], Vibrance:[-100,100,1], Saturation:[-100,100,1]},
  Curve: {'Curve shadows':[-100,100,1],'Curve midtones':[-100,100,1],'Curve lights':[-100,100,1]},
  'Color mixer':mixerControls,
  Effects:{Texture:[-100,100,1],Clarity:[-100,100,1],Vignette:[-100,100,1],Grain:[0,100,1]},
  Detail:{Sharpening:[0,100,1],'Noise reduction':[0,100,1]}
}
const linear = Float64Array.from({length:256}, (_,i) => {
  const v=i/255
  return v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4
})
function encode(v) {
  return 255*(v <= 0.0031308 ? 12.92*v : 1.055*v**(1/2.4)-0.055)
}
export function render(image, edit={}, maxSize=Infinity) {
  const canvas = document.createElement('canvas')
  const geom=geometry(image,edit,maxSize)
  const {x,y,w,h,width,height,turn,flip}=geom
  const localSource=renderLocalSource(image,edit.localTools,Math.max(width*image.width/w,height*image.height/h))
  const sourceScaleX=localSource.width/image.width,sourceScaleY=localSource.height/image.height
  canvas.width = turn%2 ? height : width
  canvas.height = turn%2 ? width : height
  const ctx = canvas.getContext('2d', {willReadFrequently:true})
  ctx.translate(canvas.width/2,canvas.height/2)
  ctx.rotate(turn*Math.PI/2)
  ctx.scale(flip ? -1 : 1,1)
  ctx.drawImage(localSource,x*sourceScaleX,y*sourceScaleY,w*sourceScaleX,h*sourceScaleY,-width/2,-height/2,width,height)
  if (!Object.values(controls).some(group=>Object.keys(group).some(key=>edit[key]))) return canvas
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height), data=pixels.data
  const value = name => (edit[name] || 0)/100
  const gain=2**(edit.Exposure || 0), slope=2**value('Contrast')
  const shadows=value('Shadows'), lights=value('Highlights'), white=value('Whites'), black=value('Blacks')
  const warmth=value('Temperature'), tint=value('Tint'), sat=value('Saturation'), vib=value('Vibrance')
  const mixer=createMixer(edit), curve=toneCurve(edit)
  const redGain=gain*2**warmth,greenGain=gain*2**(-tint/2),blueGain=gain*2**(-warmth)
  for (let i=0;i<data.length;i+=4) {
    const r=linear[data[i]]*redGain, g=linear[data[i+1]]*greenGain, b=linear[data[i+2]]*blueGain
    const lum=0.2126*r+0.7152*g+0.0722*b, y=Math.min(1,lum)
    const shift=shadows*y*(1-y)**3*2+lights*y**3*(1-y)*2+white*y**4*0.35+black*(1-y)**4*0.12
    const chroma=Math.max(r,g,b)-Math.min(r,g,b)
    const saturation=Math.max(0,1+sat+vib*(1-Math.min(1,chroma)))
    const tone=(lum+shift-0.18)*slope+0.18
    data[i]=encode(tone+(r-lum)*saturation*slope)
    data[i+1]=encode(tone+(g-lum)*saturation*slope)
    data[i+2]=encode(tone+(b-lum)*saturation*slope)
  }
  if(curve)for(let i=0;i<data.length;i+=4)for(let k=0;k<3;k++)data[i+k]=curve[data[i+k]]
  if(mixer)for(let i=0;i<data.length;i+=4)mixer(data,i)
  spatialEffects(data,canvas.width,canvas.height,edit)
  ctx.putImageData(pixels,0,0)
  return canvas
}
export function toBlob(canvas,type='image/jpeg',quality=0.92) {
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob ? resolve(blob) : reject(new Error('Image export failed')),type,quality))
}
