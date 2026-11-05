// OpenLR changes to UTIF 3.1.0, 2026-11-05. Upstream remains MIT licensed.
// Keep these targeted corrections reproducible when regenerating vendored codecs.
export function patchUtif(source) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw Error('Pinned UTIF patch no longer matches: ' + before)
    source = source.replace(before, after)
  }
  replace('if(cmpr==1 && soff.length==1) bcnt', 'if(cmpr==1 && soff.length==1 && img["t322"]==null) bcnt')
  replace(
    'else log("Unknown compression", cmpr);',
    'else throw Error("Unsupported TIFF compression: " + cmpr);'
  )
  replace(
    'else if(cmpr==1 || (len==tgt.length && cmpr!=32767)) for(var j=0; j<len; j++) tgt[toff+j] = data[off+j];',
    'else if(cmpr==1) { if(len!==expected && len!==padded) throw Error("Incomplete TIFF uncompressed block"); for(var j=0; j<expected; j++) tgt[toff+j] = data[off+j]; }'
  )
  const dimensions =
    'var bps = (img["t258"]?Math.min(32,img["t258"][0]):1);\n\tvar noc = (img["t277"]?img["t277"][0]:1), bpp=(bps*noc)>>>3, h = (img["t278"] ? img["t278"][0] : img.height), bpl = Math.ceil(bps*noc*img.width/8);'
  replace(dimensions, '// Block geometry is computed before decoding.')
  replace(
    '//var time = Date.now();',
    '//var time = Date.now();\n\tvar bps = (img["t258"]?Math.min(32,img["t258"][0]):1);\n\tvar noc = (img["t277"]?img["t277"][0]:1), bpp=(bps*noc)>>>3, h = (img["t323"] ? img["t323"][0] : img["t278"] ? img["t278"][0] : img.height), bpl = Math.ceil(bps*noc*(img["t322"] ? img["t322"][0] : img.width)/8);\n\tvar padded = h*bpl, expected = Math.min(tgt.length-toff, padded);\n\tif(!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || off<0 || len<0 || off+len>data.length) throw Error("Invalid TIFF block input bounds");'
  )
  replace(
    'UTIF.decode._decodeLZW(data, off, tgt, toff);',
    'UTIF.decode._decodeLZW(data, off, len, tgt, toff, expected, padded);'
  )
  replace(
    'UTIF.decode._decodeLZW = function(data, off, tgt, toff)',
    'UTIF.decode._decodeLZW = function(data, off, len, tgt, toff, expected, padded)'
  )
  replace(
    'var bits = 9, boff = off<<3;  // offset in bits',
    'var bits = 9, boff = off*8, end = (off+len)*8, start = toff;\n\tif(off<0 || len<0 || off+len>data.length) throw Error("Invalid TIFF LZW input bounds");'
  )
  replace(
    'while(true)\n\t{\n\t\tv = (data[boff>>>3]<<16)',
    'while(true)\n\t{\n\t\tif(boff+bits>end) throw Error("Truncated TIFF LZW stream: missing EOI");\n\t\tv = (data[boff>>>3]<<16)'
  )
  replace(
    'bits=9;  totl = 258;  chrl = 258<<2;\n\n\t\t\tv =',
    'bits=9;  totl = 258;  chrl = 258<<2;\n\n\t\t\tif(boff+bits>end) throw Error("Truncated TIFF LZW clear code");\n\t\t\tv ='
  )
  replace(
    'if(Code==EoiCode) break;\n\t\t\ttgt[toff]=Code;',
    'if(Code==EoiCode) break;\n\t\t\tif(Code>255) throw Error("Invalid TIFF LZW initial code");\n\t\t\ttgt[toff]=Code;'
  )
  replace(
    'else if(Code<totl)\n\t\t{',
    'else if(Code>totl || bits>12) throw Error("Invalid TIFF LZW dictionary code");\n\t\telse if(Code<totl)\n\t\t{'
  )
  replace(
    '\t\tOldCode = Code;\n\t}\n}',
    '\t\tif(toff-start>padded) throw Error("TIFF LZW output exceeds block size");\n\t\tOldCode = Code;\n\t}\n\tif(toff-start!==expected && toff-start!==padded) throw Error("Incomplete TIFF LZW block");\n}'
  )
  replace(
    'var bin = pako["inflate"](src);  for(var i=0; i<bin.length; i++) tgt[toff+i]=bin[i];',
    'var bin = pako["inflate"](src); if(bin.length!==expected && bin.length!==padded) throw Error("Incomplete TIFF Deflate block"); for(var i=0; i<expected; i++) tgt[toff+i]=bin[i];'
  )
  replace(
    'UTIF.decode._decodePackBits(data, off, len, tgt, toff);',
    'UTIF.decode._decodePackBits(data, off, len, tgt, toff, expected, padded);'
  )
  replace(
    'UTIF.decode._decodePackBits = function(data, off, len, tgt, toff)',
    'UTIF.decode._decodePackBits = function(data, off, len, tgt, toff, expected, padded)'
  )
  replace(
    'var sa = new Int8Array(data.buffer), ta = new Int8Array(tgt.buffer), lim = off+len;',
    'var sa = new Int8Array(data.buffer), ta = new Int8Array(tgt.buffer), lim = off+len, start = toff;'
  )
  replace(
    'var n = sa[off];  off++;',
    'var n = sa[off]; off++;\n\t\tvar count = n>=0 ? n+1 : n>=-127 ? 1-n : 0;\n\t\tif((n>=0 && off+count>lim) || (n>=-127 && n<0 && off>=lim)) throw Error("Truncated TIFF PackBits run");\n\t\tif(toff-start+count>padded) throw Error("TIFF PackBits output exceeds block size");'
  )
  replace(
    '\t\tif(n>=-127 && n<0) {  for(var i=0; i<-n+1; i++) {  ta[toff]=sa[off];  toff++;           }  off++;  }\n\t}\n}',
    '\t\tif(n>=-127 && n<0) {  for(var i=0; i<-n+1; i++) {  ta[toff]=sa[off];  toff++;           }  off++;  }\n\t}\n\tif(toff-start!==expected && toff-start!==padded) throw Error("Incomplete TIFF PackBits block");\n}'
  )
  return (
    '// OpenLR changes (2026-11-05): correct tile stride/count, honor compression, and validate block/LZW/PackBits bounds and decoded lengths.\n' +
    source
  )
}
