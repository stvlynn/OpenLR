# Synthetic Classic catalog

`lrcat.mjs` creates a new SQLite database using sql.js. It includes explicit minimal table/column capabilities from the independently documented Classic relationships: original root/folder/file/image, static and smart collections, keywords, rating/pick, scalar develop text, length-prefixed zlib XMP, a virtual copy, one missing disk original and one incomplete catalog relationship. It contains no user's catalog, photograph, Adobe database export or proprietary calibration data. DBVersion is a chosen fixture string, not proof of compatibility with that Adobe release.

Browser/native tests generate PNG originals in isolated test folders and authorize only those folders. They verify missing retry, unchanged original hashes, exact reference mappings, metadata and portable sync. Test reports explicitly call this synthetic; genuine Adobe-produced catalogs and macOS PhotoKit are not claimed as validated.
