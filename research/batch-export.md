# Batch export research

Reviewed 2026-11-05. This record informs OpenLR's selection-export design; it does not claim that a candidate transport is implemented or that Lightroom and OpenLR produce equivalent files. No third-party implementation or Adobe asset is imported.

## Evidence and its limits

The installed Lightroom 9.4 evidence remains [the existing REA and runtime ledger](lightroom.md). R1/L2 establishes separate export and previous-settings command constants. The later Windows UI observation opened and cancelled a single-photo export preview. Neither observes a multi-file write, collision handling, cancellation cleanup, or selection snapshot behavior. No repeated binary analysis was needed for this transport question.

Adobe's [desktop export guide](https://helpx.adobe.com/lightroom/desktop/save-share-and-export/save-share-photos.html), accessed on the review date and labeled updated 2025-04-24, describes exporting selected photos to a folder, displaying the selected count in the action, and reusing previous settings. This is documented product behavior, not evidence of execution on the installed build. It motivates a group workflow alongside OpenLR's existing multi-selection; it does not mandate Adobe's naming, algorithm, or storage rules.

Context7 resolved Node.js to `/websites/nodejs_latest-v24_x_api` and was queried for exclusive file creation and sequential output. Its response was checked against the project's actual [Node v24.9.0 filesystem documentation](https://github.com/nodejs/node/blob/v24.9.0/doc/api/fs.md) and [stream documentation](https://github.com/nodejs/node/blob/v24.9.0/doc/api/stream.md). Use exclusive creation and handle `EEXIST` directly rather than checking existence before an ordinary truncating open. A stream consumer must respect backpressure and observe completion/errors. An exclusive flag has documented network-filesystem limitations. The current Context7 response also includes newer `stream/iter` APIs; those were not selected for this Node 24.9.0 project.

Chrome's [File System Access guidance](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) documents directory handles, `{mode:'readwrite'}`, and writable streams. Acquire a picker handle during user activation before expensive rendering. A successful write call is not completion: the stream must close. This API is not available in every engine. Its `getFileHandle({create:true})` can return an existing file; checking names first does not create an atomic exclusive-write guarantee against another process. Browser support and destination race behavior require separate tests; a dispatched download is not proof of a saved file.

The inspected [fflate v0.8.3 README](https://github.com/101arrowz/fflate/blob/v0.8.3/README.md) documents both synchronous and streaming ZIP APIs and describes files up to 4 GB. OpenLR's existing `web/xmp.js` uses resident `zipSync` for an individual Original + XMP package. That is not a batch streaming implementation. The vendored writer uses classic size/offset fields; reader ZIP64 support alone is not proof of ZIP64 writing. Do not turn these library boundaries into an arbitrary limit on accepted original photos.

Go's [archive/zip writer at go1.27.3](https://github.com/golang/go/blob/go1.27.3/src/archive/zip/writer.go) accepts an `io.Writer`, records 64-bit sizes/offsets, and emits ZIP64 structures when needed. It is a possible later native archive adapter. It adds container lifecycle and extraction concerns and does not provide the browser implementation. Ordinary folder files need neither archive conversion nor an unzip step.

## Candidate comparison

| Candidate | What it provides | Main cost or unresolved condition |
| --- | --- | --- |
| Sequential per-photo render and bounded transfer to a folder | Ordinary photo files; reuse existing renderer and per-file transfers; completed items survive later failure | Destination adapter must handle collisions, cleanup and actual completion; one decoded image can still be large |
| All encoded files in one base64 JSON result | Reuses the one-result envelope superficially | Retains the entire group plus text serialization copies; unsuitable as the default for large selections |
| Existing `zipSync` over all originals or exports | One download result | Resident source collection plus archive; archive-format limits; not streaming |
| A new streaming ZIP writer | Potentially bounded output and one archive | New container path and platform parity work; finalization and partial-archive recovery; unnecessary for ordinary folder export |
| Browser directory writable streams | Direct folder files where supported | User activation and browser support; file-creation race semantics differ from native exclusive creation |

The selected direction is sequential ordinary files, using a shared per-photo preparation owner and platform-specific destination adapters. The ordering and completion contract below are OpenLR design choices, not reverse-engineered Adobe behavior.

## Transport memory ablation

Executed on Windows with Node v24.9.0. Each case ran in a fresh `--expose-gc` process, using eight generated 12 MiB payloads (96 MiB total). The sequential case released each item and sent 512 KiB base64 chunks to a byte consumer. The aggregate case retained every base64 string, serialized/parses the array, and decoded each result. The archive case used the repository's actual `zipSync` with level 0, matching the no-compression packaging choice.

| Case | Observed RSS increase over process baseline, three runs | Output bytes |
| --- | --- | ---: |
| Sequential chunks | 52.5, 53.0, 52.9 MiB | 100,663,296 |
| Aggregate base64 JSON | 472.5, 472.3, 472.3 MiB | 100,663,296 |
| Resident `zipSync` | 191.9, 191.8, 191.9 MiB | 100,664,006 |

The first run was alone; the two repetitions overlapped with each other. Wall times were therefore not used as a throughput comparison. RSS was sampled at explicit allocation/consumption points, not continuously: these are observed increases, not bounds on peak memory. Forced GC makes lifetime comparisons reproducible but is not a production strategy. This experiment tests transport shape only, with synthetic byte payloads, no real-photo decoding, no filesystem writes, and no browser engine. It does not establish whole-app memory usage or large-image codec support. It supports avoiding whole-group aggregation; sequential transfer still retains at least the currently encoded item and processing working memory.

Reproduce by saving the following as `.workspace/batch-export-memory.mjs` and running `node --expose-gc .workspace/batch-export-memory.mjs` from the repository root:

```js
import { spawnSync } from 'node:child_process';
import { zipSync } from '../web/vendor/fflate/browser.js';
const mode=process.argv[2];
if (!mode) {
  for (const mode of ['sequential','base64-array','zipSync']) {
    const result=spawnSync(process.execPath,['--expose-gc',import.meta.filename,mode],{encoding:'utf8'});
    if(result.status) throw Error(result.stderr);
    process.stdout.write(result.stdout);
  }
} else {
  const count=8,size=12*1024*1024,chunkSize=512*1024;
  global.gc(); const start=process.memoryUsage(), began=performance.now();
  let peak=start.rss, bytes=0, held=[];
  const sample=()=>peak=Math.max(peak,process.memoryUsage().rss);
  const consume=(b,expected)=>{if(b[0]!==expected||b[b.length-1]!==expected)throw Error('transport mismatch');bytes+=b.length;sample()};
  if(mode==='sequential') {
    for(let i=0;i<count;i++) {
      { const item=Buffer.alloc(size,i+1); sample();
        for(let j=0;j<size;j+=chunkSize) {
          const encoded=item.subarray(j,j+chunkSize).toString('base64');
          consume(Buffer.from(encoded,'base64'),i+1);
        }
      }
      global.gc();
    }
  } else if(mode==='base64-array') {
    for(let i=0;i<count;i++){held.push(Buffer.alloc(size,i+1).toString('base64'));sample()}
    const serialized=JSON.stringify(held); sample();
    const decoded=JSON.parse(serialized);sample();
    decoded.forEach((text,i)=>consume(Buffer.from(text,'base64'),i+1));
  } else {
    const inputs={};for(let i=0;i<count;i++){inputs[`${i}.bin`]=Buffer.alloc(size,i+1);sample()}
    held.push(zipSync(inputs,{level:0}));sample();bytes=held[0].length;
  }
  console.log(JSON.stringify({mode,count,itemMiB:size/1048576,chunkKiB:chunkSize/1024,payloadMiB:count*size/1048576,observedRSSIncreaseMiB:+((peak-start.rss)/1048576).toFixed(1),elapsedMs:+(performance.now()-began).toFixed(1),bytes,node:process.version,platform:process.platform}));
}
```

## Recommended observable contract

- Capture the selected visible items in display order, copied recipes, media identity and normalized options once. Later selection or edits must not redirect a running export. Preserve the active photo, history and preview; do not implement batching by repeatedly selecting a photo.
- Reuse the existing render/encode/color/metadata/sharpening pipeline. Snapshot each item's own processing version and metadata source. Decode into an owned resource when the active-source cache would otherwise mutate UI state, and dispose it after handoff.
- Validate the entire request's known format/media constraints before writing. Never silently omit an incompatible selected item. Video frame selection must be deterministic if still-frame batch output is offered; a global interactive playhead is not an implicit per-video snapshot.
- Use one destination folder and sequential item writes. Keep bounded transfer chunks, report filenames and actual completed count, and stop at the first failure/cancellation. Keep already completed files and clean up the in-progress temporary file. Do not equate rendering with saving.
- Preserve existing files by default. Use safe basenames and deterministic suffixes for duplicate names, with case-insensitive comparison for predictable cross-platform naming. Destination adapters must still prevent unintended overwrites at the actual write boundary; naming alone does not eliminate races.
- Reuse photo/video previous-settings slots. Remember a run's settings only after every requested output completes. A partial failure leaves previous settings intact and reports the completed outputs. A preference-persistence error after successful output must not cause output to be repeated.
- CLI receives a folder option and structured completion/error data, not one accumulated array of file bytes. GUI uses the same job and shows the selected count through its action. Browser download acceptance must remain distinguishable from a verified native file write.

## Evidence required from implementation

Use independent decoded output inspection for differently edited sources and both processing versions; compare dimensions, sample pixels, ICC and metadata, and original bytes. Exercise real Grid/Detail multi-selection and CLI folder output, case/Unicode collisions and pre-existing destinations, filtered selection, edits during export, failure on item two and cancellation, cleanup, previous-settings persistence and restart. Run the actual native suite on Windows, Linux and macOS; browser adapter tests alone cannot establish native file-picker behavior. Record untested media and engine boundaries explicitly rather than weakening the contract to suit existing tests.
