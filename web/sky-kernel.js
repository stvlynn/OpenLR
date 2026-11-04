import {ort,modelSession,fetchModel,cachedSkyModel} from './ai-runtime.js'
import {AI_MODELS} from './ai-models.js'

export async function inferSky({pixels,normalization='standard',modelUrl}){
  const model=AI_MODELS.sky,start=performance.now()
  const session=await modelSession(modelUrl||model.url,()=>modelUrl?fetchModel(modelUrl):cachedSkyModel(model)),loaded=performance.now()
  const {width,height,data}=pixels,area=width*height,input=new Float32Array(area*3)
  const mean=[0.485,0.456,0.406],std=[0.229,0.224,0.225]
  for(let i=0;i<area;i++)for(let c=0;c<3;c++){const v=data[i*4+c]/255;input[c*area+i]=normalization==='none'?v:(v-mean[c])/std[c]}
  const inputs={[session.inputNames[0]]:new ort.Tensor('float32',input,[1,3,height,width])}
  if(session.inputNames.length>1){
    const metadata=session.inputMetadata[1],shape=metadata.shape??metadata.dimensions
    const maskHeight=Number.isInteger(shape?.[1])?shape[1]:height,maskWidth=Number.isInteger(shape?.[2])?shape[2]:width
    inputs[session.inputNames[1]]=new ort.Tensor('int64',new BigInt64Array(maskWidth*maskHeight).fill(1n),[1,maskHeight,maskWidth])
  }
  const before=performance.now(),outputs=await session.run(inputs),inferred=performance.now()
  const tensors=Object.values(outputs),logits=tensors.find(tensor=>tensor.dims.length===3&&tensor.dims.at(-1)>150),masks=tensors.find(tensor=>tensor.dims.length===4)
  if(!logits||!masks)throw Error('Unexpected DETR panoptic outputs')
  const queries=logits.dims[1],classes=logits.dims[2],h=masks.dims[2],w=masks.dims[3],count=h*w,soft=new Float32Array(count),kept=[],summary=[]
  for(let q=0;q<queries;q++){
    let maximum=-Infinity,label=-1,sum=0
    for(let c=0;c<classes;c++)if(logits.data[q*classes+c]>maximum){maximum=logits.data[q*classes+c];label=c}
    for(let c=0;c<classes;c++)sum+=Math.exp(logits.data[q*classes+c]-maximum)
    const confidence=1/sum
    summary.push({query:q,label,confidence,skyProbability:Math.exp(logits.data[q*classes+model.label]-maximum)/sum})
    if(label===classes-1||confidence<0.5)continue
    kept.push({query:q,label,confidence})
  }
  // Panoptic masks compete across accepted queries. Independent sigmoid masks
  // are not calibrated mutually exclusive regions and leak onto the rocket.
  if(kept.some(query=>query.label===model.label))for(let i=0;i<count;i++){
    let maximum=-Infinity,total=0,sky=0
    for(const query of kept)maximum=Math.max(maximum,masks.data[query.query*count+i])
    for(const query of kept){const probability=Math.exp(masks.data[query.query*count+i]-maximum);total+=probability;if(query.label===model.label)sky+=probability}
    soft[i]=sky/(total||1)
  }
  return {width:w,height:h,mask:Uint8Array.from(soft,value=>Math.round(value*255)),provenance:{target:'sky',model:model.file,revision:model.revision,sha256:model.sha256,license:model.license,label:model.label,labelName:'sky-other-merged',runtime:'onnxruntime-web 1.31.1 / wasm CPU',normalization},metrics:{loadMs:loaded-start,preprocessMs:before-loaded,inferenceMs:inferred-before,totalMs:performance.now()-start},output:{inputs:session.inputNames,outputNames:session.outputNames,logits:[...logits.dims],masks:[...masks.dims],kept,summary:summary.sort((a,b)=>b.skyProbability-a.skyProbability).slice(0,5)}}
}
