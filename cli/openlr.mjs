#!/usr/bin/env node
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {definitions,schema,searchCommands,validateArgs} from '../web/agent-protocol.js'

const defaultSession=()=>process.env.OPENLR_AGENT_FILE||path.join(process.platform==='win32'?(process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming')):process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support'):(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config')),'OpenLR','agent.json')
const help={
  usage:'openlr <command> [--name value] [--args JSON] [--dry-run]',
  discovery:['openlr cli search "export image"','openlr schema edit','openlr <command> --help'],
  examples:['openlr state','openlr import C:/Photos/photo.jpg','openlr edit --key Exposure --value 0.5','openlr preview --output preview.png','openlr export --format image/png --output edited.png'],
  options:{'--capture':'Save a PNG of the live desktop after a data command and return both results','--args':'JSON argument object; --body is an alias','--dry-run':'Validate and print the request without contacting the GUI','--output':'Destination for image bytes; refuses an existing file unless --force','--force':'Allow overwriting the output file','--session':'Agent session file; default is the platform user config/OpenLR/agent.json'},
  workflow:'Search, inspect schema, dry-run, then run. Commands operate on the currently running native GUI. JSON goes to stdout; errors go to stderr with a nonzero exit. Images default to a generated .workspace/agent-results file.',
  commands:Object.keys(definitions)
}

function parseValue(text,rule){
  if(rule?.type==='number'||rule?.type==='integer'){
    if(text.trim()==='')throw new Error('Expected a number')
    return Number(text)
  }
  if(rule?.type==='boolean'){
    if(!['true','false'].includes(text))throw new Error('Expected true or false')
    return text==='true'
  }
  if(rule?.type==='array'||rule?.type==='object')return JSON.parse(text)
  if(rule?.oneOf){
    if(text==='true'||text==='false')return text==='true'
    if(text.trim()!==''&&Number.isFinite(Number(text)))return Number(text)
  }
  return text
}

export function parse(argv){
  const tokens=[...argv], command=tokens.shift()
  if(!command||['help','--help','-h'].includes(command))return {local:help}
  if(command==='cli'){
    if(tokens.shift()!=='search'||tokens.length!==1)throw new Error('Usage: openlr cli search "task description"')
    return {local:searchCommands(tokens[0])}
  }
  if(command==='schema'){
    if(tokens.length!==1)throw new Error('Usage: openlr schema <command>')
    return {local:schema(tokens[0])}
  }
  const definition=schema(command)
  if(tokens.includes('--help')||tokens.includes('-h'))return {local:definition}
  let args={}, output, capture, session=defaultSession(), dryRun=false, force=false
  const files=[], parameters=definition.parameters.properties
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i]
    if(token==='--dry-run'){dryRun=true;continue}
    if(token==='--force'){force=true;continue}
    if(token==='--'){
      if(command!=='import')throw new Error('Positional arguments are only supported for import')
      files.push(...tokens.slice(i+1));break
    }
    if(!token.startsWith('--')){
      if(command!=='import')throw new Error('Unexpected positional argument: '+token)
      files.push(token);continue
    }
    const equals=token.indexOf('='),key=token.slice(2,equals<0?undefined:equals)
    const value=equals<0?tokens[++i]:token.slice(equals+1)
    if(value===undefined)throw new Error('Missing value for --'+key)
    if(key==='args'||key==='body'){
      const parsed=JSON.parse(value)
      if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error('--args must be a JSON object')
      args={...args,...parsed}
    }else if(key==='session')session=value
    else if(key==='output')output=value
    else if(key==='capture')capture=value
    else if(key==='file'&&command==='import')files.push(value)
    else if(Object.hasOwn(parameters,key))args[key]=parseValue(value,parameters[key])
    else throw new Error('Unknown option: --'+key)
  }
  if(command==='import'){
    if(files.length&&Object.hasOwn(args,'files'))throw new Error('Use either import paths or --args files')
    if(files.length)args.files=files
  }
  // Edit values depend on the selected key; an aspect is an enum string.
  if(command==='edit'&&args.key==='aspect'&&typeof args.value==='number')args.value=String(args.value)
  validateArgs(command,args)
  if(command==='import'&&args.files.some(file=>typeof file!=='string'||!file))throw new Error('Import files must be nonempty local paths')
  const fileResult=Boolean(definition.returns)
  if(output&&!fileResult)throw new Error('--output requires an image command')
  if(capture&&(fileResult||capture==='-'))throw new Error('--capture needs a file path and a data-returning command')
  return {command,args,output,capture,session,dryRun,force}
}

export async function connect(filename){
  let config
  try{config=JSON.parse(await readFile(filename,'utf8'))}catch(error){throw new Error('Cannot read the GUI agent session. Start OpenLR first. Session: '+filename+' ('+error.message+')')}
  const url=new URL(config.url)
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||!config.token||config.version!==1)throw new Error('Invalid local GUI agent session')
  return {url,token:config.token}
}

const mimeTypes={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.avif':'image/avif','.tif':'image/tiff','.tiff':'image/tiff','.jxl':'image/jxl'}
async function importPayload(files){
  const result=[]
  for(const filename of files){
    const info=await stat(filename)
    if(!info.isFile())throw new Error('Not a file: '+filename)
    const bytes=await readFile(filename)
    result.push({name:path.basename(filename),type:mimeTypes[path.extname(filename).toLowerCase()]||'application/octet-stream',lastModified:info.mtimeMs,base64:bytes.toString('base64')})
  }
  return result
}

export async function execute(request){
  if(Object.hasOwn(request,'local'))return request.local
  const {command,output,capture,session,dryRun,force}=request
  if(dryRun)return {dryRun:true,transport:'live GUI agent',request:{command,args:request.args},...(output?{output}:{}),force}
  const connection=await connect(session)
  const args=command==='import'?{...request.args,files:await importPayload(request.args.files)}:request.args
  let response
  try{
    response=await fetch(new URL('/command',connection.url),{method:'POST',headers:{'Authorization':'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify({command,args,capture:Boolean(capture)}),signal:AbortSignal.timeout(120_000)})
  }catch(error){throw new Error('Cannot reach the live OpenLR GUI agent: '+(error.cause?.message||error.message))}
  const envelope=await response.json()
  if(!response.ok||!envelope.ok)throw new Error(envelope.error?.message||envelope.error||'Agent returned HTTP '+response.status)
  const result=envelope.result
  if(capture){
    if(!envelope.frame)throw Error('The desktop did not return a workspace image')
    return {result,selected:envelope.selected,frame:await writeImage(envelope.frame,capture,force)}
  }
  if(result?.kind!=='file')return result
  return writeImage(result,output,force)
}
async function writeImage(result,output,force){
  if(typeof result.base64!=='string')throw new Error('Invalid image response')
  const bytes=Buffer.from(result.base64,'base64')
  if(bytes.length!==result.bytes||bytes.length===0)throw new Error('Incomplete image response')
  let destination
  if(output==='-'){
    if(process.stdout.isTTY)throw new Error('Use --output <file> for images, or redirect --output - to a file')
    process.stdout.write(bytes)
    return {rawOutput:true}
  }
  if(output)destination=path.resolve(output)
  else{
    const directory=path.resolve('.workspace','agent-results')
    await mkdir(directory,{recursive:true})
    destination=path.join(directory,Date.now()+'-'+crypto.randomUUID().slice(0,8)+'-'+path.basename(result.filename||'preview.png'))
  }
  await writeFile(destination,bytes,{flag:force?'w':'wx'})
  return {path:destination,filename:result.filename,mimeType:result.mimeType,bytes:bytes.length}
}

export async function main(argv=process.argv.slice(2)){
  try{
    const result=await execute(parse(argv))
    if(!result?.rawOutput)process.stdout.write(JSON.stringify(result??null,null,2)+'\n')
  }catch(error){
    process.stderr.write(JSON.stringify({error:{code:'OPENLR_CLI_ERROR',message:error.message}})+'\n')
    process.exitCode=1
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main()
