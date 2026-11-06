#!/usr/bin/env bash
set -euo pipefail

if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_OS:-} != Linux ]]; then
  echo 'Use a fresh disposable Ubuntu runner' >&2
  exit 1
fi
package=$(realpath "${1:?Pass the generated Debian package}")
launcher=/usr/bin/openlr
payload=/opt/openlr
desktop=/usr/share/applications/openlr.desktop
mime=/usr/share/mime/packages/openlr.xml
if dpkg-query -W openlr >/dev/null 2>&1 || [[ -e "$payload" || -L "$launcher" || -e "$launcher" || -e "$desktop" || -e "$mime" ]]; then
  echo 'Expected a fresh runner without OpenLR' >&2
  exit 1
fi

remove_package() {
  if dpkg-query -W openlr >/dev/null 2>&1; then
    sudo dpkg --purge openlr
  fi
}
trap remove_package EXIT
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends "$package" xvfb libglib2.0-bin
test "$(dpkg-query -W -f='${db:Status-Status}' openlr)" = installed
test "$(readlink -f "$launcher")" = "$payload/openlr"
grep -Fx 'Exec=/opt/openlr/openlr %U' "$desktop"
grep -Fx 'MimeType=image/jpeg;image/png;image/x-adobe-dng;image/tiff;' "$desktop"
test -f "$mime"

xvfb-run -a dbus-run-session -- node scripts/native-installed-cli-smoke.mjs "$launcher" "$payload/cli/openlr.mjs"
xvfb-run -a dbus-run-session -- node scripts/native-file-open-smoke.mjs "$launcher" "$desktop"
xvfb-run -a dbus-run-session -- node scripts/native-suite.mjs "$launcher"

remove_package
trap - EXIT
if dpkg-query -W openlr >/dev/null 2>&1 || [[ -e "$payload" || -L "$launcher" || -e "$launcher" || -e "$desktop" || -e "$mime" ]]; then
  echo 'Purge left OpenLR package files or integration' >&2
  exit 1
fi
echo 'Debian install, native suite, installed CLI and purge verified.'
