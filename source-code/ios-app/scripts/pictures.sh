#!/bin/sh
# The app's screens as pictures on one Simulator: each tab and each state of a connection with the
# example addresses of a debug build (AppModel, showDemo), then the first start. The App Store's
# pictures come from here.
#
#   sh ios-app/scripts/pictures.sh <path of HProxy.app> <device id> <name>
set -eu
APP=$1
DEVICE=$2
NAME=$3
OUT="$(dirname "$0")/../pictures"
mkdir -p "$OUT"

# A screenshot needs a window: the Simulator app has to be showing the device.
xcrun simctl boot "$DEVICE" || true
open -a Simulator --args -CurrentDeviceUDID "$DEVICE"
xcrun simctl bootstatus "$DEVICE" -b
xcrun simctl status_bar "$DEVICE" override --time 9:41 --batteryState charged --batteryLevel 100 \
  --wifiBars 3 --cellularBars 4 || true

xcrun simctl uninstall "$DEVICE" com.hproxy.app || true
xcrun simctl install "$DEVICE" "$APP"

shot() {
  file=$1
  shift
  xcrun simctl terminate "$DEVICE" com.hproxy.app || true
  xcrun simctl launch "$DEVICE" com.hproxy.app "$@"
  sleep 5
  xcrun simctl io "$DEVICE" screenshot "$OUT/$NAME-$file.png"
}

shot connected -welcomed YES -demo on -tab 0
shot off -welcomed YES -demo off -tab 0
shot stopped -welcomed YES -demo stopped -tab 0
shot proxies -welcomed YES -demo on -tab 1
shot settings -welcomed YES -demo on -tab 2
# Last: right after a boot, iOS shows its own banners over the top of the screen.
shot welcome

xcrun simctl terminate "$DEVICE" com.hproxy.app || true
xcrun simctl shutdown "$DEVICE" || true
