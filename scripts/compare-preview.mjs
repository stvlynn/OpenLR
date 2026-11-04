import {chromium} from 'playwright-core'
import {serveWorkspace} from '../tests/browser-server.mjs'
const server=await serveWorkspace()
let browser
try{
  browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome'})
  const page=await browser.newPage()
  await page.goto(server.url)
  const results=await page.evaluate(async()=>{
    const {render}=await import('./render.js')
    const img=document.createElement('canvas')
    img.width=3000;img.height=2000
    const ctx=img.getContext('2d'),gradient=ctx.createLinearGradient(0,0,3000,2000)
    gradient.addColorStop(0,'#151f36');gradient.addColorStop(.45,'#819d5a');gradient.addColorStop(1,'#fcfaef')
    ctx.fillStyle=gradient;ctx.fillRect(0,0,img.width,img.height)
    const image=await createImageBitmap(img),edit={Exposure:0.75,Contrast:8,Shadows:12,Saturation:7}
    const reference=render(image,edit)
    const size=960
    function sample(canvas){
      const thumbnail=document.createElement('canvas');thumbnail.width=size;thumbnail.height=640
      const g=thumbnail.getContext('2d');g.drawImage(canvas,0,0,size,640)
      return g.getImageData(0,0,size,640).data
    }
    const pixels=sample(reference),results=[]
    for(const edge of [960,1280,3000]){
      const times=[]
      let data
      for(let i=0;i<4;i++){
        const begin=performance.now();const result=render(image,edit,edge)
        data=sample(result);if(i)times.push(performance.now()-begin)
      }
      let error=0
      for(let i=0;i<data.length;i+=4)for(let c=0;c<3;c++)error+=Math.abs(data[i+c]-pixels[i+c])
      results.push({edge,medianMs:Math.round(times.sort((a,b)=>a-b)[1]),meanChannelError:Number((error/(data.length*.75)).toFixed(3))})
    }
    image.close()
    return results
  })
  console.log(JSON.stringify({browser:browser.version(),source:'3000x2000 gradient',viewport:'960x640',results},null,2))
}finally{await browser?.close();server.close()}
