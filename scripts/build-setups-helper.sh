#!/bin/sh
# Fixed Darwin helper; no test barriers or provider commands enter this build.
# Failed compiler stages are retained as original evidence.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname)" = Darwin ] || { echo 'Setups helper requires the existing Apple SDK.' >&2; exit 1; }
mkdir -p native/setups-build
pf_setups_stage=$(mktemp -d native/setups-build/.stage.XXXXXX)
for pf_setups_arch in arm64 x86_64; do
  /usr/bin/clang -std=c11 -Wall -Wextra -Werror -pedantic -fstack-protector-strong \
    -arch "$pf_setups_arch" -mmacosx-version-min=12.0 \
    native/setups-targets/reader.c native/setups-targets/snapshot.c \
    native/setups-targets/writer.c native/setups-targets/receipt.c \
    native/setups-targets/journal-gate.c native/setups-targets/recovery.c \
    native/setups-targets/store.c native/setups-targets/protocol.c \
    native/setups-targets/protocol-transport.c native/setups-targets/bootstrap.c \
    native/setups-targets/helper.c -o "$pf_setups_stage/buddy-setups-$pf_setups_arch"
done
/usr/bin/lipo -create "$pf_setups_stage/buddy-setups-arm64" "$pf_setups_stage/buddy-setups-x86_64" -output "$pf_setups_stage/buddy-setups"
/usr/bin/lipo "$pf_setups_stage/buddy-setups" -verify_arch arm64 x86_64
chmod 755 "$pf_setups_stage/buddy-setups"
# This is build provenance, not a post-signature binary checksum or launch grant.
node scripts/setups-helper-manifest.js "$pf_setups_stage"
mv "$pf_setups_stage/buddy-setups" native/setups-build/buddy-setups
mv "$pf_setups_stage/helper-manifest.json" native/setups-build/helper-manifest.json
echo 'Setups helper: strict universal native/setups-build/buddy-setups (activation separately gated)'
