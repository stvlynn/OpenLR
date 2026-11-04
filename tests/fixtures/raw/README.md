# Licensed camera RAW fixture

`canon-powershot-g1.crw` is a genuine Canon PowerShot G1 camera file from raw.pixls.us, not a generated DNG renamed to another extension. The repository record explicitly marks sample 2073 CC0-1.0. The adjacent JSON retains the exact public URL, license link, byte count, and published SHA-256. `scripts/fetch-dng-fixture.mjs` downloads that one file and verifies its hash before writing it.

The original camera file is used to verify OpenLR's real LibRaw decoding and non-DNG-to-LinearRaw conversion. It does not come from a user's photo library. The CC0 grant is documented by the [repository](https://raw.pixls.us/) and [CC0 legal code](https://creativecommons.org/publicdomain/zero/1.0/legalcode).
