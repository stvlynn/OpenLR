# Tethered capture

Use **Tethered capture…** in the header or File menu, refresh cameras, select a supported still camera and choose **Capture & add to library**. The result follows the same importer, metadata, decoder, edit and export paths as ordinary files. Captured originals on the camera are not deleted by OpenLR.

The native service supports two concrete adapters:

| Adapter | Discovery/capture behavior |
| --- | --- |
| Windows WIA | Enumerates camera devices, checks for TakePicture, then executes TakePicture and transfers the returned image using the installed device driver |
| Installed gphoto2 | Runs `--auto-detect`, selects the reported model/port, and executes `--capture-image-and-download --keep`; camera/driver-specific capture errors remain errors |

OpenLR does not bundle a camera driver, vendor SDK or gphoto2. An ordinary webcam is not automatically treated as a remotely controlled still camera. Unsupported/disconnected devices and missing backends are displayed explicitly. This initial flow captures one operation at a time; it does not claim live view, camera setting controls, indefinite tether-event monitoring or support for every PTP camera.

```sh
node cli/openlr.mjs camera-list
node cli/openlr.mjs tether
node cli/openlr.mjs camera-capture --id <camera-id>
```

Downloaded files are kept in the current user's `OpenLR/camera-captures/` directory before library import. `OPENLR_CAMERA_DIRECTORY` selects another capture directory. The native protocol serves only files produced by a known capture session, and downloaded bytes have no application-level size cap.

For contract testing without hardware, `OPENLR_CAMERA_SIMULATOR` may point to a directory of generated image fixtures. This is a test-only opt-in, never an automatic fallback for missing hardware. Discovery, UI names, returned capture metadata and imported photos all mark it **SIMULATOR / simulated:true**. It copies fixture bytes without changing the source.

`node scripts/native-camera-smoke.mjs <executable>` passed the real native transport, labeled simulator discovery, file transfer, library import, DNG original export, unchanged fixture bytes and workspace screenshot. It did not validate a physical shutter or camera driver. Local WIA discovery returned no still cameras and gphoto2 was unavailable. See [the environment/source evidence](../research/tethered-capture.md).
