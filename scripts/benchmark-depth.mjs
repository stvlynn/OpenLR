import {createServer} from 'node:http'
import {readFile,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright-core'
const server=createServer(async(req,res)=>{try{const file=new URL(req.url,'http://localhost').pathname.slice(1)||'web/index.html';if(file.includes('..'))throw Error();res.setHeader('Content-Type',/\.m?js$/.test(file)?'text/javascript':file.endsWith('.wasm')?'application/wasm':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(await readFile(file))}catch{res.writeHead(404).end()}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome',headless:true})
try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/web/index.html')
  const result=await page.evaluate(async()=>{
    const {inferDepth}=await import('./depth-kernel.js'),records=[],figure=document.createElement('canvas');figure.width=1152;figure.height=768;const ctx=figure.getContext('2d');ctx.fillStyle='#181818';ctx.fillRect(0,0,1152,768)
    for(const [row,file]of ['astronaut.png','rocket.jpg'].entries()){
      const bitmap=await createImageBitmap(await(await fetch('/tests/fixtures/ai/'+file)).blob()),c=document.createElement('canvas'),scale=518/Math.min(bitmap.width,bitmap.height);c.width=Math.round(bitmap.width*scale/14)*14;c.height=Math.round(bitmap.height*scale/14)*14;const context=c.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0,c.width,c.height);const pixels=context.getImageData(0,0,c.width,c.height)
      const tile=(image,column,label)=>{const w=384,h=356,scale=Math.min(w/image.width,h/image.height);ctx.drawImage(image,column*w+(w-image.width*scale)/2,row*384+28+(h-image.height*scale)/2,image.width*scale,image.height*scale);ctx.fillStyle='#eee';ctx.font='14px sans-serif';ctx.fillText(label,column*w+8,row*384+20)}
      tile(bitmap,0,file)
      for(const [column,normalization]of ['standard','none'].entries()){
        const output=await inferDepth({pixels,normalization,modelUrl:'/.tools/ai-models/depth-model_quantized.onnx'}),mean=(x,y,w,h)=>{let sum=0,n=0;for(let py=Math.floor(y*output.height);py<(y+h)*output.height;py++)for(let px=Math.floor(x*output.width);px<(x+w)*output.width;px++){sum+=output.mask[py*output.width+px]/255;n++}return sum/n}
        records.push({file,normalization,metrics:output.metrics,output:output.output,probes:file==='astronaut.png'?{person:mean(.38,.15,.12,.19),background:mean(.77,.03,.18,.2)}:{sky:mean(.56,.07,.1,.45),rocket:mean(.49,.4,.02,.3),ground:mean(.45,.965,.1,.025)}})
        const map=document.createElement('canvas');map.width=output.width;map.height=output.height;const m=map.getContext('2d'),data=m.createImageData(map.width,map.height);for(let i=0;i<output.mask.length;i++){data.data[i*4]=data.data[i*4+1]=data.data[i*4+2]=output.mask[i];data.data[i*4+3]=255}m.putImageData(data,0,0);tile(map,column+1,'Relative depth / '+normalization)
      }
      bitmap.close()
    }
    return {records,image:figure.toDataURL().split(',')[1],userAgent:navigator.userAgent}
  })
  await writeFile('research/ai/depth-qualitative.png',Buffer.from(result.image,'base64'));delete result.image;await writeFile('research/ai/depth-benchmark.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}finally{await browser.close();server.closeAllConnections();server.close()}
