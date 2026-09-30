#!/bin/sh
# Compiles native/calendar-helper.swift into native/bin/buddy-calendar, which
# electron-builder bundles as a resource. No Swift toolchain (or not macOS):
# the app still builds, and Calendar just shows as unavailable in Settings.
set -e
cd "$(dirname "$0")/.."
mkdir -p native/bin
if [ "$(uname)" != "Darwin" ] || ! command -v swiftc >/dev/null 2>&1; then
  echo "calendar helper: skipped (needs macOS + swiftc)"
  exit 0
fi
swiftc -O -target arm64-apple-macos12 -o native/bin/buddy-calendar-arm64 native/calendar-helper.swift
swiftc -O -target x86_64-apple-macos12 -o native/bin/buddy-calendar-x86_64 native/calendar-helper.swift
lipo -create -output native/bin/buddy-calendar native/bin/buddy-calendar-arm64 native/bin/buddy-calendar-x86_64
rm -f native/bin/buddy-calendar-arm64 native/bin/buddy-calendar-x86_64
echo "calendar helper: native/bin/buddy-calendar"
