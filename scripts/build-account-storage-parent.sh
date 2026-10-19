#!/bin/sh
# Fixed provenance gate only. Building does not authorize Keychain access.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname)" = Darwin ] || { echo 'Account storage guard requires the Apple SDK.' >&2; exit 1; }
mkdir -p native/account-storage-build
pf_account_stage=$(mktemp -d native/account-storage-build/.parent-stage.XXXXXX)
for pf_account_arch in arm64 x86_64; do
  /usr/bin/clang -std=c11 -Wall -Wextra -Werror -pedantic -fobjc-arc -fstack-protector-strong \
    -arch "$pf_account_arch" -mmacosx-version-min=12.0 -O2 \
    -framework Foundation -framework AppKit -framework Security \
    native/account-storage-parent.m -o "$pf_account_stage/buddy-account-storage-parent-$pf_account_arch"
done
/usr/bin/lipo -create "$pf_account_stage/buddy-account-storage-parent-arm64" \
  "$pf_account_stage/buddy-account-storage-parent-x86_64" -output "$pf_account_stage/buddy-account-storage-parent"
/usr/bin/lipo "$pf_account_stage/buddy-account-storage-parent" -verify_arch arm64 x86_64
chmod 755 "$pf_account_stage/buddy-account-storage-parent"
mv "$pf_account_stage/buddy-account-storage-parent" native/account-storage-build/buddy-account-storage-parent
echo 'Account storage guard: strict universal native/account-storage-build/buddy-account-storage-parent'
