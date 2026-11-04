import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const directory='web/vendor/lensfun',files=['compact-canon.xml','slr-canon.xml','slr-nikon.xml','mil-sony.xml']
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'")
const first=(xml,name)=>decode(xml.match(new RegExp('<'+name+'>([\\s\\S]*?)</'+name+'>'))?.[1]?.trim()||'')
const all=(xml,name)=>[...xml.matchAll(new RegExp('<'+name+'(?:\\s+[^>]*)?>([\\s\\S]*?)</'+name+'>','g'))].map(m=>decode(m[1].trim()))
const attributes=s=>Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]))
const aspect=s=>{const parts=String(s||'3:2').split(':').map(Number);return parts.length===2?parts[0]/parts[1]:parts[0]}
const cameras=[],profiles=[],sourceFiles={}
for(const file of files){
  const bytes=await readFile(directory+'/'+file),xml=bytes.toString('utf8')
  sourceFiles[file]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
  for(const match of xml.matchAll(/<camera>([\s\S]*?)<\/camera>/g)){
    const data=match[1];cameras.push({maker:first(data,'maker'),model:first(data,'model'),aliases:all(data,'model'),mount:first(data,'mount'),cropFactor:Number(first(data,'cropfactor'))})
  }
  let lensIndex=0
  for(const match of xml.matchAll(/<lens>([\s\S]*?)<\/lens>/g)){
    const data=match[1],index=lensIndex++,type=first(data,'type')||'rectilinear'
    if(type!=='rectilinear')continue
    let calibrationIndex=0
    for(const block of data.matchAll(/<calibration([^>]*)>([\s\S]*?)<\/calibration>/g)){
      const attr=attributes(block[1]),calibration=block[2],distortion=[],tca=[]
      for(const item of calibration.matchAll(/<(distortion|tca)\s+([^>]+)\/>/g)){
        const attrs=attributes(item[2]),accepted=item[1]==='distortion'?['poly3','poly5','ptlens']:['linear','poly3']
        if(!accepted.includes(attrs.model))continue
        const sample=Object.fromEntries(Object.entries(attrs).map(([k,v])=>[k,k==='model'?v:Number(v)]))
        ;(item[1]==='distortion'?distortion:tca).push(sample)
      }
      if(!distortion.length&&!tca.length)continue
      profiles.push({id:file.replace('.xml','')+':'+index+':'+calibrationIndex++,maker:first(data,'maker'),model:first(data,'model'),aliases:all(data,'model'),mounts:all(data,'mount'),cropFactor:Number(attr.cropfactor||first(data,'cropfactor')||1),aspectRatio:aspect(attr['aspect-ratio']||first(data,'aspect-ratio')),distortion,tca,source:file})
    }
  }
}
const metadata={license:'CC-BY-SA-3.0',source:'https://github.com/lensfun/lensfun',commit:'bc5615d6278cb5fb75dd53e74015367453d5591d',sourceFiles}
await writeFile('web/lens-data.js','// Adapted Lensfun database data, CC BY-SA 3.0. See vendor/lensfun/NOTICE.\nexport const LENS_DATA='+JSON.stringify({metadata,cameras,profiles})+'\n')
await writeFile(directory+'/manifest.json',JSON.stringify({...metadata,cameras:cameras.length,profiles:profiles.length},null,2)+'\n')
console.log(JSON.stringify({cameras:cameras.length,profiles:profiles.length,license:metadata.license}))
