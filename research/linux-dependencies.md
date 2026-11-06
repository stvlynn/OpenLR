# Linux APT dependency downloads

On November 6, 2026, the Ubuntu 24.04 job for `ffb5bff` exhausted its 30-minute budget while downloading dependencies on runner image `20261101.360.1`. The index refresh took about six seconds. APT reported 150 new packages and 92.6 MB to download. The first 127 requests from the Azure archive represented about 45.7 MB of advertised payload over 1,218 seconds, approximately 37.5 kB/s. APT spent a further six minutes on the 25.5 MB WebKitGTK request before marking it ignored, and the job was canceled during the Flite download. Go checks, the package build and native verification had not started. [Failed job](https://github.com/stvlynn/OpenLR/actions/runs/42183466413/job/127778195539)

The pinned runner image puts the Azure HTTP mirror first, Canonical's HTTPS archive second and its HTTPS security mirror third. It configures one retry and a 15-second HTTP/HTTPS connection and data timeout. This bounds inactive transfers while a slowly advancing download can still take several minutes. APT uses signed archive metadata to authenticate packages independently of the download transport. [Pinned mirror setup](https://raw.githubusercontent.com/actions/runner-images/ubuntu24/20261101.360/images/ubuntu/scripts/build/configure-apt-sources.sh) · [Pinned APT settings](https://raw.githubusercontent.com/actions/runner-images/ubuntu24/20261101.360/images/ubuntu/scripts/build/configure-apt.sh) · [APT HTTP transport](https://manpages.ubuntu.com/manpages/noble/man1/apt-transport-http.1.html) · [Ubuntu archive verification](https://documentation.ubuntu.com/security/software-integrity/archive-verification/)

Run **Linux APT mirror probe** manually for a same-runner comparison. The probe refreshes the stock indexes with a separate time limit and resolves the WebKitGTK candidate version and package path from APT metadata. It requests the first 4 MiB from Azure HTTP, Canonical HTTPS and Azure HTTPS, then reverses that order. Each curl request has a 45-second total budget, does not follow redirects and discards the payload. The log records the runner image, effective retry/timeout settings, exact candidate and path, HTTP status, Content-Range, bytes received, elapsed time and transfer rate. The HTTPS Azure sample helps distinguish the host from a transport effect.

A complete comparison requires HTTP 206, the requested bounds and full package size in Content-Range, 4 MiB received and curl exit zero. A timed-out 206 with matching bounds is useful partial-transfer evidence. An ignored range, redirect, missing package or other response is recorded separately. This sample measures archive payload delivery from one runner. It does not measure installation, the full dependency set, or every runner region. The manual workflow does not install packages or alter mirror configuration or signature verification. [Probe workflow](../.github/workflows/linux-mirror-probe.yml) · [curl range and transfer reporting](https://curl.se/docs/manpage.html)

## Hosted comparison

The November 6 probe passed on amd64 runner image `20261101.360.1`, the image version used by the canceled job. Signed index refresh took about 4.4 seconds. APT selected `libwebkit2gtk-4.1-0` version `2.52.6-0ubuntu0.24.04.1` with a package size of 25,528,616 bytes. All six requests returned HTTP 206 and exactly bytes 0–4,194,303. [Probe job](https://github.com/stvlynn/OpenLR/actions/runs/42188152263/job/127793345322)

| Endpoint        | Pass 1 elapsed | Pass 1 bytes/s | Pass 2 elapsed | Pass 2 bytes/s |
| --------------- | -------------: | -------------: | -------------: | -------------: |
| Azure HTTP      |     0.090499 s |     46,346,412 |     0.108110 s |     38,796,633 |
| Canonical HTTPS |     1.452273 s |      2,888,096 |     1.473512 s |      2,846,467 |
| Azure HTTPS     |     0.424001 s |      9,892,203 |     0.457647 s |      9,164,932 |

Azure HTTP delivered the fastest sample in both orders. The probe did not reproduce the earlier slow transfer or establish its cause. This measurement gives no basis for replacing the production mirror order.
