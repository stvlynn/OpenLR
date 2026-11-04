import {mkdir,readFile,writeFile,copyFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const source='node_modules/@techstark/opencv-js',target='web/vendor/opencv'
const pkg=JSON.parse(await readFile(source+'/package.json','utf8'))
if(pkg.version!=='5.0.0-release.1')throw Error('Expected the locked OpenCV.js 5.0.0-release.1 artifact')
await mkdir(target,{recursive:true})
await copyFile(source+'/dist/opencv.js',target+'/opencv.js')
await copyFile(source+'/LICENSE',target+'/LICENSE')
const cv=await(await import('@techstark/opencv-js')).default
await writeFile(target+'/build-information.txt',cv.getBuildInformation())
const files={}
for(const name of await readdir(target)){
  if(name==='manifest.json'||name==='.gitattributes')continue
  const bytes=await readFile(target+'/'+name)
  files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
}
await writeFile(target+'/manifest.json',JSON.stringify({package:pkg.name,version:pkg.version,license:pkg.license,opencv:'5.0.0',unmodifiedArtifact:'opencv.js',upstream:'https://github.com/TechStark/opencv-js',source:'https://github.com/opencv/opencv/tree/5.0.0',files},null,2)+'\n')
console.log('Vendored unchanged OpenCV.js '+pkg.version+' with retained license inventory')
