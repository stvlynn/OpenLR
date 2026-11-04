import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const modelManifest=JSON.parse(await readFile('web/models/manifest.json','utf8'))
async function get(url){const response=await fetch(url,{headers:{'User-Agent':'OpenLR-ai-provenance'}});if(!response.ok)throw Error(response.status+' '+url);return Buffer.from(await response.arrayBuffer())}
const commit=async repo=>JSON.parse((await get('https://api.github.com/repos/'+repo+'/commits/HEAD')).toString()).sha
let prior
try{prior=JSON.parse(await readFile('web/models/notices.json','utf8'))}catch{}
const detr=prior?.revisions.detr??await commit('facebookresearch/detr'),taxonomy=prior?.revisions.taxonomy??await commit('cocodataset/panopticapi')
const files=[
  ['web/vendor/onnx/LICENSE','https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.1/LICENSE'],
  ['web/vendor/onnx/ThirdPartyNotices.txt','https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.1/ThirdPartyNotices.txt'],
  ['web/models/LICENSE.DETR','https://raw.githubusercontent.com/facebookresearch/detr/'+detr+'/LICENSE'],
  ['web/models/LICENSE.COCO-TAXONOMY','https://raw.githubusercontent.com/cocodataset/panopticapi/'+taxonomy+'/license.txt'],
  ['web/models/COCO-PANOPTIC-CATEGORIES.json','https://raw.githubusercontent.com/cocodataset/panopticapi/'+taxonomy+'/panoptic_coco_categories.json'],
  ['web/models/README.PPHumanSeg.md','https://raw.githubusercontent.com/opencv/opencv_zoo/'+modelManifest.sources.zoo+'/models/human_segmentation_pphumanseg/README.md'],
  ['web/models/README.DETR.md','https://huggingface.co/facebook/detr-resnet-50-panoptic/resolve/d53b52a799403a8867920f82c869e40732b47037/README.md']
]
const records=await Promise.all(files.map(async([path,url])=>{
  const bytes=await get(url);await writeFile(path,bytes)
  return {path,url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
}))
await writeFile('web/models/notices.json',JSON.stringify({revisions:{detr,taxonomy},files:records},null,2)+'\n')
console.log('Retained fixed model/runtime licenses and original COCO panoptic taxonomy')
