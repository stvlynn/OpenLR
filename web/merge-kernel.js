import {mergeHDR,mergePanorama} from './merge-core.js'
let runtime
export async function processMerge({kind,frames,options}){
  if(!runtime)runtime=(async()=>{await import('./vendor/opencv/opencv.js');return await globalThis.cv})()
  const cv=await runtime
  return {result:kind==='hdr'?mergeHDR(cv,frames,options):mergePanorama(cv,frames,options)}
}
