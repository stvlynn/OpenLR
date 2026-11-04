import test from 'node:test'
import assert from 'node:assert/strict'
import {chromium} from 'playwright-core'
import {serveWorkspace} from './browser-server.mjs'

test('content-aware removal uses surrounding pixels; both solvers preserve unmasked pixels and original bytes',async t=>{
  const server=await serveWorkspace();t.after(server.close)
  const browser=await chromium.launch({channel:process.env.CHROME_CHANNEL||'chrome'});t.after(()=>browser.close())
  const page=await browser.newPage();await page.goto(server.url)
  const results=await page.evaluate(async()=>{
    const {run}=await import('./app.js'),size=128
    const canvas=document.createElement('canvas');canvas.width=canvas.height=size
    const ctx=canvas.getContext('2d',{willReadFrequently:true})
    const pattern=ctx.createImageData(size,size)
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const i=(y*size+x)*4
      pattern.data.set([40+x*.6+y*.5,70+x*.3+y*.6,160+x*.2-y*.5,255],i)
    }
    ctx.putImageData(pattern,0,0)
    ctx.fillStyle='#ff0000';ctx.fillRect(60,48,8,32)
    const damaged=ctx.getImageData(0,0,size,size)
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))
    const file=new File([blob],'scratched.png',{type:'image/png'})
    await run('import',{files:[file]})
    const stats=[]
    for(const algorithm of ['telea','ns']){
      await run('mask.add',{mask:{type:'brush',points:[{x:.5,y:.375},{x:.5,y:.625}],radius:.05,feather:0,adjustments:{}}})
      const start=performance.now()
      await run('remove-mask',{algorithm})
      const elapsed=Math.round(performance.now()-start)
      const {blob:result}=await run('export',{format:'image/png'}),image=await createImageBitmap(result)
      ctx.drawImage(image,0,0);image.close()
      const {data}=ctx.getImageData(0,0,size,size)
      let error=0,referenceError=0,outside=0
      for(let y=0;y<size;y++)for(let x=0;x<size;x++)for(let c=0;c<3;c++){
        const i=(y*size+x)*4+c
        if(x>=60&&x<68&&y>=48&&y<80){error+=Math.abs(data[i]-pattern.data[i]);referenceError+=Math.abs(damaged.data[i]-pattern.data[i])}
        if(x<55||x>73||y<39||y>89)outside+=Math.abs(data[i]-damaged.data[i])
      }
      stats.push({algorithm,ms:elapsed,mae:error/(8*32*3),damagedMAE:referenceError/(8*32*3),outside})
      await run('reset')
    }
    const {blob:original}=await run('export',{format:'original'})
    return {stats,originalUnchanged:String(new Uint8Array(await original.arrayBuffer()))===String(new Uint8Array(await file.arrayBuffer()))}
  })
  console.log('Inpaint ablation',results.stats)
  assert.equal(results.originalUnchanged,true)
  for(const sample of results.stats){assert.ok(sample.mae<sample.damagedMAE*.1);assert.equal(sample.outside,0)}
})
