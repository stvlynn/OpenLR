// Parameters use sRGB for hue selection and linear-light luminance for tonal edits.
const channels={Red:0,Orange:30,Yellow:60,Green:120,Aqua:180,Blue:240,Purple:275,Magenta:320}
export const mixerControls=Object.fromEntries(Object.keys(channels).flatMap(color=>['Hue','Saturation','Luminance'].map(component=>[color+' '+component,[-100,100,1]])))
export function createMixer(edit){
  const active=Object.entries(channels).filter(([name])=>['Hue','Saturation','Luminance'].some(c=>edit[name+' '+c]))
  if(!active.length)return null
  return (data,i)=>{
    let r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255
    const hi=Math.max(r,g,b),lo=Math.min(r,g,b),delta=hi-lo
    if(!delta)return
    let h=60*(hi===r?(g-b)/delta:hi===g?2+(b-r)/delta:4+(r-g)/delta)
    h=(h+360)%360
    let l=(hi+lo)/2,s=delta/(1-Math.abs(2*l-1)),dh=0,ds=0,dl=0
    for(const [name,center] of active){
      const distance=Math.abs(h-center)
      const weight=Math.max(0,1-Math.min(distance,360-distance)/45)/100
      dh+=(edit[name+' Hue']||0)*weight*30
      ds+=(edit[name+' Saturation']||0)*weight
      dl+=(edit[name+' Luminance']||0)*weight
    }
    h=(h+dh+360)%360/60
    s=Math.min(1,Math.max(0,s*(1+ds)))
    l=Math.min(1,Math.max(0,l+(dl>0?1-l:l)*dl*0.6))
    const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs(h%2-1)),m=l-c/2
    const sector=Math.floor(h)
    const rgb=[[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][sector]
    for(let k=0;k<3;k++)data[i+k]=(rgb[k]+m)*255
  }
}
export function spatialEffects(data,width,height,edit){
  const sharp=(edit.Sharpening||0)/100,noise=(edit['Noise reduction']||0)/100
  const vignette=(edit.Vignette||0)/100,grain=(edit.Grain||0)/100
  const clarity=(edit.Clarity||0)/100,texture=(edit.Texture||0)/100
  if(!sharp&&!noise&&!vignette&&!grain&&!clarity&&!texture)return
  const source=sharp||noise||clarity||texture?data.slice():null
  const radius=Math.max(1,Math.round(Math.min(width,height)*0.008))
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4
    const d=((x+.5)/width*2-1)**2+((y+.5)/height*2-1)**2
    const edge=Math.min(1,d/1.7)**1.5*vignette
    // A reproducible grain pattern for repeated exports at a given resolution.
    let hash=Math.imul(x+1,0x45d9f3b)^Math.imul(y+1,0x27d4eb2d)
    hash=Math.imul(hash^(hash>>>16),0x45d9f3b)
    const speck=((hash>>>0)/0xffffffff-.5)*grain*38
    for(let k=0;k<3;k++){
      let v=data[i+k]
      if(source){
        let sum=0,weight=0,wide=0
        for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
          const index=(Math.max(0,Math.min(height-1,y+dy))*width+Math.max(0,Math.min(width-1,x+dx)))*4+k
          const n=source[index],w=1/(1+Math.abs(n-v)/12)
          sum+=n*w;weight+=w
          if(clarity)wide+=source[(Math.max(0,Math.min(height-1,y+dy*radius))*width+Math.max(0,Math.min(width-1,x+dx*radius)))*4+k]
        }
        const detail=v-sum/weight
        v+=detail*(sharp*3+texture*2-noise)
        if(clarity)v+=(v-wide/4)*clarity*0.7
      }
      data[i+k]=v+(edge<0?v:255-v)*edge+speck
    }
  }
}
// Linear interpolation between the endpoints and three editable quarter stops.
export function toneCurve(edit){
  const keys=['Curve shadows','Curve midtones','Curve lights']
  if(!keys.some(k=>edit[k]))return null
  const stops=[0,...keys.map((k,i)=>Math.max(0,Math.min(255,64*(i+1)+(edit[k]||0)*0.8))),255]
  return Uint8ClampedArray.from({length:256},(_,i)=>{
    const pos=i/255*4,lo=Math.min(3,Math.floor(pos))
    return stops[lo]+(pos-lo)*(stops[lo+1]-stops[lo])
  })
}
