const tags=['Make','Model','LensModel','DateTimeOriginal','ExposureTime','FNumber','ISO','FocalLength','Artist','Copyright']
export async function metadata(file){
  try{
    const {parse}=await import('./vendor/exifr/exifr.js')
    const values=await parse(file,{pick:tags})
    if(!values)return {}
    return Object.fromEntries(tags.filter(key=>values[key]!=null).map(key=>{
      const v=values[key]
      return [key,v instanceof Date?v.toISOString():v]
    }))
  }catch{return {}}
}
export function describe(photo){
  const m=photo.metadata||{}
  const info=[photo.name,photo.width+' × '+photo.height,[m.Make,m.Model].filter(Boolean).join(' '),m.LensModel]
  const speed=m.ExposureTime, exposure=[speed?(speed<1?'1/'+Math.round(1/speed):speed)+' s':'',m.FNumber?'ƒ/'+m.FNumber:'',m.ISO?'ISO '+m.ISO:'',m.FocalLength?m.FocalLength+' mm':'']
  info.push(exposure.filter(Boolean).join(' · '),m.DateTimeOriginal?new Date(m.DateTimeOriginal).toLocaleString():'',m.Artist,m.Copyright)
  return info.filter(Boolean).join('\n')
}
