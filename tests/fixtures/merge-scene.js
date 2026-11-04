import {deflateSync} from 'node:zlib'

const srgb=value=>Math.round(255*Math.max(0,Math.min(1,value<=0.0031308?value*12.92:1.055*value**(1/2.4)-0.055)))
function hash(x,y){let n=Math.imul(x+137,374761393)^Math.imul(y+83,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295}
export function scene(x,y,hdr=false){
  const tile=hash(Math.floor(x/11),Math.floor(y/13)),detail=hash(x,y)*0.12
  const light=hdr?0.006*(500**(x/600)):(0.14+tile*0.5)
  return [light*(0.65+tile*0.6+detail),light*(0.8+hash(Math.floor(x/17),Math.floor(y/9))*0.4+detail),light*(0.7+tile*0.4+detail)]
}
export function frame(width,height,{x=0,y=0,ev=0,hdr=false,flat=false}={}){
  const data=new Uint8ClampedArray(width*height*4)
  for(let row=0;row<height;row++)for(let col=0;col<width;col++){
    const rgb=flat?[0.4,0.4,0.4]:scene(x+col,y+row,hdr),i=(row*width+col)*4
    for(let c=0;c<3;c++)data[i+c]=srgb(rgb[c]*(2**ev))
    data[i+3]=255
  }
  return {width,height,data,metadata:{ExposureTime:2**ev,FNumber:1,ISO:100}}
}
const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^(n&1?0xedb88320:0)}return(n^0xffffffff)>>>0}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,checksum])}
export function png(image){
  const header=Buffer.alloc(13);header.writeUInt32BE(image.width,0);header.writeUInt32BE(image.height,4);header[8]=8;header[9]=6
  const rows=Buffer.alloc((image.width*4+1)*image.height)
  for(let y=0;y<image.height;y++)rows.set(image.data.subarray(y*image.width*4,(y+1)*image.width*4),y*(image.width*4+1)+1)
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])
}
