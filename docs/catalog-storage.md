# Catalog media storage

Catalog schema version **5** stores new media into 8 MiB `ArrayBuffer` records in `media`. The original/photo record contains a small `chunks-v2` descriptor with type, filename, modification time, byte length and chunk count. `mediaRecords` tracks the chunk keys owned by each photo/original row. These stores contain the media already supplied to the catalog; they do not add a second copy of originals or copy AI model weights into the photo database.

New media, including thumbnails, takes the same chunked path on every engine. In a real isolated WebKit run the first unsupported Blob write stalled before delivering an abort event. Writing chunks directly avoids both a probe and a large single-record ArrayBuffer. Legacy records remain readable.

Chunk data, owner metadata, photo/original rows and removal of unreferenced chunks share one IndexedDB readwrite transaction. A multi-entry ownership index checks only replaced references when reclaiming storage. A duplicate ID or another write failure rolls everything back. The `withMedia` writer receives a `commit` callback that owns this transaction; bulk photo saves and sync use that callback. Code deleting photo/original rows uses `deleteRecord` so its media ownership is removed in the same transaction.

Readers accept legacy native Blobs, `bytes-v1` ArrayBuffer wrappers, and new chunk descriptors. New chunks are read with a cursor and combined into a Blob/File; they are not joined into one ArrayBuffer for persistence. File name, MIME type, modification time and exact bytes are preserved. A missing chunk is an explicit error. Hydrated media references are reused when rating/metadata changes or a virtual copy points at the same thumbnail, avoiding repeated media writes. Separate original IDs remain the source of truth for virtual copies.

The 8 MiB value is a transport/storage record size, not a photo size limit. Preparing a transaction and rendering/encoding media still consumes browser RAM, and actual disk quota or codec limits can fail visibly. The chunk adapter does not change the independent AI model cache.

## Verification

`node --test tests/catalog.test.js` uses a real browser and a **140 MiB + 17 byte** generated file. It rejects all stored Blobs and rejects individual ArrayBuffers larger than 16 MiB, verifies 18 media slices, and reloads the page to check every byte plus the tail sentinel. It also verifies preserved File metadata, native-Blob and legacy-ArrayBuffer reads, no extra media for rating/virtual-copy changes, atomic rollback without orphan slices, and reclamation after removing the owning rows. The test passed on Chromium. Separate native smoke tests exercise the current platform's actual IndexedDB implementation through import/edit/export.
