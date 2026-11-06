# Native depth verification

On 2026-11-06 the packaged Windows build ran the [native depth smoke](../scripts/native-depth-smoke.mjs) with WebView2, Windows build 26200 and Node 24.9.0. OpenLR fetched the pinned 27,258,801-byte Depth Anything V2 Small ONNX model in a fresh native session and ran it through ONNX Runtime Web WASM CPU. The result reported revision `4472b7362082ad9968fee890ca0f1e5aca36b93d` and 2,738.6 ms of inference. [Model provenance](ai/depth-weight.json) · [Depth tool contract](../docs/range-depth-tools.md)

The input was the retained 512×512 public-domain NASA portrait of Eileen Collins from scikit-image v0.25.2. The CLI imported the actual file and generated a 518×518 normalized relative inverse-depth raster. The portrait and background probes returned 0.266 and 0.057. These are weak region checks on a single portrait. [Fixture provenance](../tests/fixtures/ai/README.md)

- **Estimate**. The saved raster contained the normalized endpoints and a diverse distribution. The decoded photo was identical before and after estimation.
- **Range**. Independently sampling the raster identified 119,900 included and 142,230 excluded pixels away from the rounding boundaries. The decoded grayscale mask agreed with that coverage. An exposure adjustment changed 117,880 included pixels and left every checked excluded pixel identical. Undo restored the baseline while retaining the raster.
- **Lens blur**. The decoded export retained exact RGB values for 98,401 in-focus samples and changed 157,522 out-of-focus samples. The sum of horizontal RGB edge differences in the far region fell from 1,130,497 to 257,109. Alpha stayed identical. An invalid focus interval preserved the saved settings, and disabling blur restored the baseline. Both tools reused the same saved raster.
- **Original**. The source file and native original export matched byte for byte.

From the repository root, run the same smoke against a built executable with network access to the pinned model host.

```powershell
node scripts/native-depth-smoke.mjs build/retouch-order/windows-amd64/OpenLR.exe
```

The first CLI request has a 150-second deadline for download and inference. The remaining requests use the ordinary native harness deadline. The recorded Windows run exited successfully and its ignored log is `.workspace/native-depth-windows-cold.log`. The measurements describe this fixture and runtime. Separate runs are needed for other platforms, download failures and cache reuse across restarts.
