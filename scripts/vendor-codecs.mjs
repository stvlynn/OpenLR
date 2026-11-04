import {mkdir,readdir,readFile,writeFile,copyFile} from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'

const root='web/vendor/codecs'
await mkdir(root,{recursive:true})
for(const codec of ['avif','jxl']){
  const source='node_modules/@jsquash/'+codec,target=path.join(root,codec)
  async function copy(from,to){
    await mkdir(to,{recursive:true})
    for(const item of await readdir(from,{withFileTypes:true})){
      if(item.isDirectory())await copy(path.join(from,item.name),path.join(to,item.name))
      else if(/\.(js|mjs|wasm)$/.test(item.name)||item.name==='LICENSE'){
        const file=path.join(from,item.name),destination=path.join(to,item.name)
        if(item.name==='encode.js')await writeFile(destination,"// OpenLR modification: resolve wasm-feature-detect through a local relative module.\n"+(await readFile(file,'utf8')).replaceAll("'wasm-feature-detect'","'../wasm-feature-detect.js'"))
        else await copyFile(file,destination)
      }
    }
  }
  await copy(source,target)
}
await copyFile('node_modules/wasm-feature-detect/dist/esm/index.js',path.join(root,'wasm-feature-detect.js'))
await copyFile('node_modules/wasm-feature-detect/LICENSE',path.join(root,'LICENSE.wasm-feature-detect'))
const pako=await readFile('node_modules/pako/dist/pako.js','utf8')
await writeFile(path.join(root,'pako.js'),'// ESM adapter around unmodified pako UMD source.\nconst module={exports:{}}; const exports=module.exports;\n'+pako+'\nexport default module.exports;\n')
const utif=await readFile('node_modules/utif/UTIF.js','utf8')
await writeFile(path.join(root,'utif.js'),"// ESM adapter around unmodified UTIF CommonJS source.\nimport pako from './pako.js';\nconst module={exports:{}};const require=name=>{if(name==='pako')return pako;throw Error('Unknown dependency: '+name)};\n"+utif+'\nexport default module.exports;\n')
await copyFile('node_modules/utif/LICENSE',path.join(root,'LICENSE.UTIF'))
await copyFile('node_modules/pako/LICENSE',path.join(root,'LICENSE.pako'))
await copyFile('node_modules/pako/lib/zlib/README',path.join(root,'NOTICE.pako-zlib'))
const hashes={}
async function inventory(folder){
  for(const item of await readdir(folder,{withFileTypes:true})){
    const file=path.join(folder,item.name)
    if(item.isDirectory())await inventory(file)
    else if(/\.(js|mjs|wasm)$/.test(item.name)){const bytes=await readFile(file);hashes[path.relative(root,file).replaceAll('\\','/')]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}
  }
}
await inventory(root)
await writeFile(path.join(root,'manifest.json'),JSON.stringify({packages:{utif:'3.1.0',pako:'1.0.11','@jsquash/avif':'2.1.1','@jsquash/jxl':'1.3.0','wasm-feature-detect':'1.9.0'},files:hashes},null,2)+'\n')
console.log('Vendored TIFF/AVIF/JPEG XL modules with unchanged WASM and retained notices')
