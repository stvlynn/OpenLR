// Shared UI, application, and CLI contract. Keep existing formats in their order.
export const EXPORT_FORMATS=[
  {value:'image/jpeg',label:'JPEG',extension:'jpg',quality:true},
  {value:'image/png',label:'PNG',extension:'png',quality:false},
  {value:'original',label:'Original',extension:null,quality:false},
  {value:'image/tiff',label:'TIFF',extension:'tif',quality:false},
  {value:'image/avif',label:'AVIF',extension:'avif',quality:true},
  {value:'image/jxl',label:'JPEG XL',extension:'jxl',quality:true}
]
export const EXPORT_TYPES=EXPORT_FORMATS.map(format=>format.value)
export const CODEC_TYPES=['image/tiff','image/avif','image/jxl']
export function photoFormat(file){
  const extension=(file.name||'').split('.').pop().toLowerCase()
  const format=EXPORT_FORMATS.find(format=>format.extension===extension||(format.value==='image/tiff'&&extension==='tiff'))
  return format?.value??file.type
}
export function exportFilename(name,format){
  if(format==='original')return name
  const definition=EXPORT_FORMATS.find(item=>item.value===format)
  if(!definition)throw Error('Unsupported export format')
  return name.replace(/\.[^.]+$/,'')+'.'+definition.extension
}
