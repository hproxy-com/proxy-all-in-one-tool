#!/bin/sh
# The Rust engine as a static library, where ios-app/project.yml looks for it: for the
# Simulator (`sim`), a real iPhone (`device`), or both. Needs a Mac: run by codemagic.yaml.
set -eu
cd "$(dirname "$0")/../.."
export IPHONEOS_DEPLOYMENT_TARGET=16.0

build() {
  cargo rustc -p hproxy-mobile --lib --crate-type staticlib --profile phone --target "$1"
  mkdir -p "ios-app/engine/$2"
  cp "target/$1/phone/libhproxy_mobile.a" "ios-app/engine/$2/"
}

case "${1:-both}" in
  sim) build aarch64-apple-ios-sim iphonesimulator ;;
  device) build aarch64-apple-ios iphoneos ;;
  both)
    build aarch64-apple-ios-sim iphonesimulator
    build aarch64-apple-ios iphoneos
    ;;
  *)
    echo "sim, device or both" >&2
    exit 1
    ;;
esac
