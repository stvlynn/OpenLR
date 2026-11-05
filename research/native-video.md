# Native video verification

The 2026-11-06 [native video smoke](../scripts/native-video-smoke.mjs) generates a three-second VP9/Opus WebM. Its consecutive one-second segments pair red, green, and blue frames with 330, 660, and 990 Hz tones. The real desktop CLI imports the clip, seeks, advances playback, pauses, trims to 1.2–2.7 seconds, rotates the frames, and writes previews, a saved catalog frame, and the trimmed WebM. A separate Chrome page uses the bundled MediaBunny sinks and Chrome's decoders to inspect the written files. It checks the saved PNG against the paused preview and samples two frames and two windows of decoded PCM in the trim. The test also checks that the exports preserve the selected asset, paused playback, and catalog edit, and that exporting the original returns the same bytes as the source fixture.

| Local execution                                                                   | Play → advanced → paused, seconds | WebM container / decoded PCM, seconds | 660 / 990 Hz amplitude | Original bytes |
| --------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------- | ---------------------- | -------------- |
| Windows WebView2, packaged `build/organization-state/windows-amd64/OpenLR.exe`    | 0.350 → 0.544285 → 0.548517       | 1.513 / 1.5135                        | 0.19974 / 0.20005      | 27,479         |
| WSL Ubuntu 24.04, WebKitGTK 2.52.6, Xvfb and D-Bus, with the VP9 parser available | 0.350 → 0.565917 → 0.582758       | 1.500 / 1.4935                        | 0.20009 / 0.20017      | 27,487         |

Both runs used Node 24.9.0 and produced a 64×96 saved still and a 64×96 VP9/Opus WebM. The saved still matched the blue preview sample. The exported green and blue segments had the expected tones, and both decoded audio windows had RMS near 0.141. The audio evidence comes from the exported PCM samples. Physical audio output and macOS execution remain unverified for this workflow. The ignored log for the final Windows run is `.workspace/native-video-windows.log`.

## Linux VP9 parser

The Linux runtime probe used the pre-existing executable under `openlr-acceptance-8ec94b8/build/release/linux-amd64/openlr`. The archive directory is a provenance label. It has no Git metadata, and its copy of `web/video.js` matched the current source byte for byte. The host used Ubuntu's `libwebkit2gtk-4.1-0` 2.52.6-0ubuntu0.24.04.1 with `gstreamer1.0-plugins-good` 1.24.2-1ubuntu1.8. The Chrome fixture and decoder used version 157.0.8103.38.

1. With the installed GStreamer plugins, import, seek, time advance, pause, trim, and the rotated preview reached their assertions. Export failed with `This device cannot encode every source track in the selected video format`. WebKit stderr identified the missing `vp9parse` element. The command stopped at export.
2. Both Ubuntu packages, `gstreamer1.0-plugins-bad` and `libgstreamer-plugins-bad1.0-0` at version 1.24.2-1ubuntu4, were unpacked into temporary storage. `GST_PLUGIN_PATH_1_0` exposed only `libgstvideoparsersbad.so`, `LD_LIBRARY_PATH` supplied its codec parser library, and `GST_REGISTRY_1_0` selected a private registry. The system packages stayed as installed. [Ubuntu parser package](https://packages.ubuntu.com/noble/gstreamer1.0-plugins-bad) · [Ubuntu package file list](https://packages.ubuntu.com/noble/amd64/gstreamer1.0-plugins-bad/filelist)
3. With the same executable and smoke, the test passed through export, independent frame and audio decoding, original bytes, and save-frame. WebKit still reported missing WebVTT encoding and `autovideoflip` in this selective extraction. The paired observations are retained in the ignored `.workspace/native-video-linux-missing-parser.log` and `.workspace/native-video-linux-provisioned.log`.

The missing parser was the export blocker in this environment. CI now installs `gstreamer1.0-plugins-bad`, and the Linux package manifest declares the base, good, and bad sets for Opus, VP9, and the parser. See the [desktop runtime requirements](../docs/desktop.md).

## Package metadata

A separate MyGo v0.7.4 Linux build used an isolated extraction of the exact `2753c7a` source archive with the current `mygo.json`. This checked generated metadata independently of the runtime experiment above.

- `dpkg-deb -f openlr_0.1.0_amd64.deb Depends` returned `libgtk-3-0 | libgtk-3-0t64, libwebkit2gtk-4.1-0, gstreamer1.0-plugins-base, gstreamer1.0-plugins-good, gstreamer1.0-plugins-bad`.
- The generated Arch PKGBUILD contains `depends=('gtk3' 'webkit2gtk-4.1' 'gst-plugins-base' 'gst-plugins-good' 'gst-plugins-bad')`. The Arch package file lists show the Opus, VP9, and parser plugin locations. [Arch base plugins](https://archlinux.org/packages/extra/x86_64/gst-plugins-base/files/) · [Arch good plugins](https://archlinux.org/packages/extra/x86_64/gst-plugins-good/files/) · [Arch parser package](https://archlinux.org/packages/extra/x86_64/gst-plugins-bad-libs/files/)
