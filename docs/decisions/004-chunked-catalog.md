# 004: Transactional media chunks in the browser catalog

Status: accepted, 2026-11-05.

WebKit's ephemeral IndexedDB can reject Blob commits, while a fallback that stores an entire large file as one ArrayBuffer can exceed a browser record/IPC limit. Importing a photograph must not silently truncate it, duplicate its full original, or impose a fixed application file size ceiling.

Catalog v4 uses 8 MiB chunks for large media and for Blob-incompatible stores. Small owner descriptors retain original file metadata. Chunk records, owner references, application records and orphan cleanup commit together. Reads remain compatible with the former native Blob and `bytes-v1` formats. Loaded media descriptors are reused for metadata-only writes and virtual-copy thumbnails.

Alternatives considered: one large ArrayBuffer retains the same record-size failure; separate chunk transactions can leave incomplete originals after failure; a native-only database would remove the browser workflow and change domain/persistence contracts. The chosen adapter preserves the existing Blob/File interface used by codecs, rendering and sync.

Consequences: the database adds two stores and a schema version. Writers must use `withMedia`'s commit callback, and destructive row operations must update owner metadata. The adapter bounds individual records but does not remove RAM/disk-quota or codec constraints. The 140 MiB rejection/reopen test and native smoke results are described in [catalog storage](../catalog-storage.md).
