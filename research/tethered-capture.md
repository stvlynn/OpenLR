# Tethered capture research

Inspected on 2026-11-05. The local Windows `WIA.DeviceManager` COM object was available but returned no imaging devices. Windows PnP listed a USB webcam; that is not evidence of a WIA/PTP still camera or a remote-shutter capability. `gphoto2` was absent from Windows and the installed WSL Ubuntu 24.04 distribution. No physical still camera was available for capture validation.

Microsoft documents [Device.ExecuteCommand](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wiaaut/-wiaaut-idevice-executecommand), the [TakePicture command identifier](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wiaaut/-wiaaut-consts-commandid), and [Item.Transfer](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wiaaut/-wiaaut-iitem-transfer). A device driver's reported commands determine whether the WIA TakePicture operation is offered. OpenLR uses these system APIs through a fixed PowerShell COM adapter; it does not install a driver or enable camera privacy permissions.

The [gphoto2 manual](https://gphoto.sourceforge.io/doc/manual/ref-gphoto2-cli.html) documents device discovery and immediate capture/download. Its keep option retains images on the camera, while the default download behavior may remove the camera copy. OpenLR explicitly requests retention. Compatibility and shutter support depend on the connected device/driver. The [remote-control guide](https://gphoto.sourceforge.io/doc/remote/) describes additional camera-specific capture settings; OpenLR does not silently change those settings.

[Canon's SDK overview](https://www.usa.canon.com/support/sdk) describes EDSDK/CCAPI for compatible Canon devices. Those vendor components were neither installed nor imported; vendor licensing, access and compatibility requirements must be addressed for a future concrete SDK integration.

The implementation is described in [tethered capture](../docs/tethered-capture.md). Simulator contract success is recorded separately from physical camera support.
