import {createServer} from 'node:http'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {chromium} from 'playwright-core'
const server=createServer(async(req,res)=>{
  try{
    const file=new URL(req.url,'http://localhost').pathname.slice(1)||'web/index.html'
    if(file.includes('..')||!/^[\w./-]+$/.test(file))throw Error()
    res.setHeader('Content-Type',/\.m?js$/.test(file)?'text/javascript':file.endsWith('.wasm')?'application/wasm':file.endsWith('.png')?'image/png':file.endsWith('.css')?'text/css':'text/html')
    res.end(await readFile(file))
  }catch{res.writeHead(404).end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true})
try{
  const page=await browser.newPage()
  await page.goto('http://127.0.0.1:'+server.address().port+'/')
  const result=await page.evaluate(async({skyOnly,fp32})=>{
    const {inferSemantic,modelFor}=await import('./web/ai-kernel.js')
    const image=await createImageBitmap(await(await fetch('/tests/fixtures/ai/astronaut.png')).blob())
    const figure=document.createElement('canvas');figure.width=1152;figure.height=768
    const fig=figure.getContext('2d');fig.fillStyle='#171819';fig.fillRect(0,0,1152,768)
    function tile(original,column,row,label,result){
      const cell=384,scale=Math.min(cell/original.width,(cell-28)/original.height),w=original.width*scale,h=original.height*scale,x=column*cell+(cell-w)/2,y=row*cell+28+(cell-28-h)/2
      fig.fillStyle='#eeeeee';fig.font='15px sans-serif';fig.fillText(label,column*cell+12,row*cell+20);fig.drawImage(original,x,y,w,h)
      if(result){
        const overlay=document.createElement('canvas');overlay.width=result.width;overlay.height=result.height
        const context=overlay.getContext('2d'),pixels=context.createImageData(result.width,result.height)
        for(let i=0;i<result.mask.length;i++){pixels.data[i*4]=255;pixels.data[i*4+3]=Math.round(result.mask[i]*0.45)}
        context.putImageData(pixels,0,0);fig.drawImage(overlay,x,y,w,h)
      }
    }
    tile(image,0,0,'NASA astronaut — original')
    const records=[]
    for(const target of skyOnly?[]:['subject','person'])for(const normalization of ['standard','none'])for(let pass=0;pass<2;pass++){
      const model=modelFor(target),canvas=document.createElement('canvas');canvas.width=model.width;canvas.height=model.height
      canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height)
      const result=await inferSemantic({pixels:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height),target,normalization})
      // Region probes are manual interior/background labels, not an exhaustive ground truth.
      const rectangles={person:[[0.38,0.15,0.12,0.19],[0.26,0.5,0.3,0.2]],background:[[0.03,0.05,0.12,0.2],[0.77,0.03,0.18,0.2]]},scores={}
      for(const [label,regions]of Object.entries(rectangles)){
        let sum=0,count=0
        for(const [x,y,w,h]of regions)for(let row=Math.ceil(y*result.height);row<(y+h)*result.height;row++)for(let col=Math.ceil(x*result.width);col<(x+w)*result.width;col++){sum+=result.mask[row*result.width+col]/255;count++}
        scores[label]=sum/count
      }
      records.push({target,normalization,pass,metrics:result.metrics,scores,output:result.output,coverage:result.mask.reduce((sum,v)=>sum+v,0)/result.mask.length/255})
      if(normalization==='standard'&&pass===1)tile(image,target==='subject'?1:2,0,target==='subject'?'U2NetP subject':'PPHumanSeg person',result)
    }
    image.close()
    const rocket=await createImageBitmap(await(await fetch('/tests/fixtures/ai/rocket.jpg')).blob())
    tile(rocket,0,1,'SpaceX rocket — original')
    for(const shortEdge of [320,512])for(const normalization of ['standard','none']){
      const scale=shortEdge/Math.min(rocket.width,rocket.height),canvas=document.createElement('canvas');canvas.width=Math.round(rocket.width*scale);canvas.height=Math.round(rocket.height*scale)
      canvas.getContext('2d').drawImage(rocket,0,0,canvas.width,canvas.height)
      const result=await inferSemantic({pixels:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height),target:'sky',normalization,modelUrl:'/.tools/ai-models/'+(fp32?'detr-fp32.onnx':'detr-quantized.onnx')})
      const regions={sky:[[0.16,0.08,0.09,0.45],[0.56,0.07,0.1,0.45]],nonSky:[[0.49,0.4,0.02,0.3],[0.45,0.965,0.1,0.025]]},scores={}
      for(const [label,rectangles]of Object.entries(regions)){
        let sum=0,count=0
        for(const [x,y,w,h]of rectangles)for(let row=Math.ceil(y*result.height);row<(y+h)*result.height;row++)for(let col=Math.ceil(x*result.width);col<(x+w)*result.width;col++){sum+=result.mask[row*result.width+col]/255;count++}
        scores[label]=sum/count
      }
      records.push({target:'sky',shortEdge,normalization,metrics:result.metrics,regions,scores,output:result.output,coverage:result.mask.reduce((sum,v)=>sum+v,0)/result.mask.length/255})
      if(normalization==='standard')tile(rocket,shortEdge===320?1:2,1,'DETR sky — '+shortEdge+' short edge',result)
    }
    rocket.close()
    return {userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,records,figure:figure.toDataURL().split(',')[1]}
  },{skyOnly:process.argv.includes('--sky-only'),fp32:process.argv.includes('--fp32')})
  await mkdir('research/ai',{recursive:true})
  const {figure,...report}=result
  const suffix=process.argv.includes('--fp32')?'-fp32':''
  await writeFile('research/ai/'+(process.argv.includes('--sky-only')?'benchmark-sky':'benchmark')+suffix+'.json',JSON.stringify(report,null,2)+'\n')
  await writeFile('research/ai/'+(process.argv.includes('--sky-only')?'sky-qualitative':'qualitative')+suffix+'.png',Buffer.from(figure,'base64'))
  console.log(JSON.stringify(report,null,2))
}finally{await browser.close();server.closeAllConnections();server.close()}
