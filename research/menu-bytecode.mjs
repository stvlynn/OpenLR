// Inspect selected instructions in a PE resource range previously identified by REA.
import {open} from 'node:fs/promises'
const [file,offset,size,query]=process.argv.slice(2)
if(!query)throw Error('Usage: node research/menu-bytecode.mjs file resourceOffset resourceSize commandFragment')
const input=await open(file,'r'),data=Buffer.alloc(Number(size))
try{const {bytesRead}=await input.read(data,0,data.length,Number(offset));if(bytesRead!==data.length)throw Error('Incomplete resource')}finally{await input.close()}
if(data.subarray(0,12).toString('hex')!=='1b4c75615100010408040800')throw Error('Expected little-endian Lua 5.1 with 64-bit size_t')
let cursor=12
function take(n){if(cursor+n>data.length)throw Error('Unexpected end');const result=data.subarray(cursor,cursor+n);cursor+=n;return result}
const u8=()=>take(1)[0],u32=()=>take(4).readUInt32LE()
function string(){const n=Number(take(8).readBigUInt64LE());return n?take(n).toString('utf8',0,n-1):null}
const ops='MOVE LOADK LOADBOOL LOADNIL GETUPVAL GETGLOBAL GETTABLE SETGLOBAL SETUPVAL SETTABLE NEWTABLE SELF ADD SUB MUL DIV MOD POW UNM NOT LEN CONCAT JMP EQ LT LE TEST TESTSET CALL TAILCALL RETURN FORLOOP FORPREP TFORLOOP SETLIST CLOSE CLOSURE VARARG'.split(' ')
function prototype(path){
  string();take(12)
  const n=u32(),codeAt=cursor,code=Array.from({length:n},()=>u32())
  const constants=Array.from({length:u32()},()=>{
    switch(u8()){
      case 0:return null
      case 1:return Boolean(u8())
      case 3:return take(8).readDoubleLE()
      case 4:return string()
      default:throw Error('Unknown constant type')
    }
  })
  const regs=new Map()
  for(let pc=0;pc<code.length;pc++){
    const i=code[pc],op=ops[i&63],a=(i>>>6)&255,b=i>>>23,c=(i>>>14)&511,bx=i>>>14
    const rk=k=>k>255?constants[k-256]:regs.get(k)
    const literal=op==='LOADK'?constants[bx]:op==='SETTABLE'&&c>255?rk(c):null
    if(typeof literal==='string'&&literal.includes(query)){
      console.log(JSON.stringify({prototype:path,pc,offset:Number(offset)+codeAt+4*pc,op,
        targetRegister:a,key:op==='SETTABLE'?rk(b):undefined,literal,next:code.slice(pc+1,pc+4).map(word=>ops[word&63])}))
    }
    if(op==='LOADK'||op==='GETGLOBAL')regs.set(a,constants[bx])
    else if(op==='MOVE')regs.set(a,regs.get(b))
    else if(op==='GETTABLE')regs.set(a,[regs.get(b),rk(c)].filter(Boolean).join('.'))
    else if(op==='CALL'||op==='TAILCALL'){
      const args=Array.from({length:Math.max(0,b-1)},(_,j)=>regs.get(a+j+1)??null)
      if(args.some(value=>typeof value==='string'&&value.includes(query))){
        console.log(JSON.stringify({prototype:path,pc,offset:Number(offset)+codeAt+4*pc,op,callee:regs.get(a)??null,args}))
      }
      regs.delete(a)
    }else if(['NEWTABLE','LOADBOOL','GETUPVAL','CLOSURE','LOADNIL'].includes(op))regs.delete(a)
    else if(['JMP','RETURN','TEST','TESTSET','EQ','LT','LE'].includes(op))regs.clear()
  }
  const nested=u32()
  for(let i=0;i<nested;i++)prototype(path+'.'+i)
  take(4*u32())
  for(let i=u32();i;i--){string();take(8)}
  for(let i=u32();i;i--)string()
}
prototype('0')
if(cursor!==data.length)throw Error('Unexpected trailing resource data')

