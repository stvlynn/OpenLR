import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'

export async function serveWorkspace(){
  const server=createServer(async(req,res)=>{
    try{
      const file=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html'
      if(!/^[\w./-]+$/.test(file)||file.includes('..'))throw Error()
      const types={html:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',wasm:'application/wasm'}
      res.setHeader('Content-Type',types[file.split('.').pop()]||'application/octet-stream')
      res.end(await readFile(new URL('../web/'+file,import.meta.url)))
    }catch{res.writeHead(404).end()}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>{server.closeAllConnections();server.close()}}
}
