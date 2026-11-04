import {mkdir,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const fixture={
  make:'Canon',model:'PowerShot G1',container:'CRW',license:'CC0-1.0',
  licenseUrl:'https://creativecommons.org/publicdomain/zero/1.0/',
  repository:'https://raw.pixls.us/',
  metadata:'https://raw.pixls.us/json/getrepository.php',
  url:'https://raw.pixls.us/getfile.php/2073/nice/Canon - PowerShot G1 - RAW (4:3).crw',
  sha256:'f39be5acf14057ce04527fd8d0574e57ec8ed5fed082d7bfaff763075a44ee8a'
}
const response=await fetch(fixture.url)
if(!response.ok)throw Error('RAW sample download failed: '+response.status)
const bytes=new Uint8Array(await response.arrayBuffer()),hash=createHash('sha256').update(bytes).digest('hex')
if(hash!==fixture.sha256)throw Error('RAW fixture hash mismatch; no fixture was written')
await mkdir('tests/fixtures/raw',{recursive:true})
await writeFile('tests/fixtures/raw/canon-powershot-g1.crw',bytes)
await writeFile('tests/fixtures/raw/canon-powershot-g1.json',JSON.stringify({...fixture,bytes:bytes.length,purpose:'Actual non-DNG camera RAW to 16-bit LinearRaw DNG validation; no user photographs'},null,2)+'\n')
console.log(JSON.stringify({file:'tests/fixtures/raw/canon-powershot-g1.crw',bytes:bytes.length,sha256:hash,license:fixture.license},null,2))
