#!/bin/sh
# Plexiform installer: curl -fsSL https://plexiform.dev/install.sh | sh
# Downloads the newest release from GitHub, checks its SHA-256 against the
# release's SHA256SUMS.txt, and installs it. No sudo, no Apple Developer ID.
# A file fetched by curl carries no quarantine flag, so macOS Gatekeeper has
# nothing to block. Env: PLEXIFORM_CHANNEL=stable (skip pre-releases),
# PLEXIFORM_APPLICATIONS_DIR (macOS install folder).
set -eu

REPO=CallumJB125/claude-traffic-light
API=${PLEXIFORM_API_BASE:-https://api.github.com/repos/$REPO}
BUNDLE_ID=dev.plexiform.app

die() { echo "plexiform install: $*" >&2; exit 1; }
say() { echo "plexiform install: $*"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

os=$(uname -s)
cpu=$(uname -m)
case "$os-$cpu" in
  Darwin-arm64) pattern='/Plexiform-[^/]*-mac-arm64\.zip$' ;;
  Darwin-x86_64) pattern='/Plexiform-[^/]*-mac-x64\.zip$' ;;
  Linux-x86_64) pattern='/Plexiform-[^/]*-linux-x86_64\.AppImage$' ;;
  *) die "no build for $os $cpu. Releases: https://github.com/$REPO/releases" ;;
esac

# stable = GitHub's latest non-pre-release; otherwise the newest release of any kind
if [ "${PLEXIFORM_CHANNEL:-}" = stable ]; then release=$API/releases/latest; else release=$API/releases?per_page=1; fi
curl -fsSL -o "$tmp/release.json" "$release" || die "could not read the release list from $release"
urls=$(grep -o '"browser_download_url" *: *"[^"]*"' "$tmp/release.json" | sed 's/.*: *"\(.*\)"/\1/' || true)
asset=$(printf '%s\n' "$urls" | grep -E "$pattern" | head -n 1 || true)
sums=$(printf '%s\n' "$urls" | grep -E '/SHA256SUMS\.txt$' | head -n 1 || true)
[ -n "$asset" ] || die "the newest release has no build for $os $cpu"
[ -n "$sums" ] || die "the newest release has no SHA256SUMS.txt, so the download cannot be verified"
name=${asset##*/}

say "downloading $name"
curl -fL --progress-bar -o "$tmp/$name" "$asset" || die "download failed: $asset"
curl -fsSL -o "$tmp/SHA256SUMS.txt" "$sums" || die "could not download $sums"

want=$(awk -v f="$name" '{ n = $2; sub(/^\*/, "", n) } n == f { print tolower($1) }' "$tmp/SHA256SUMS.txt")
[ -n "$want" ] || die "$name is not listed in SHA256SUMS.txt"
if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$tmp/$name"); else got=$(sha256sum "$tmp/$name"); fi
got=${got%% *}
[ "$got" = "$want" ] || die "SHA-256 mismatch for $name (expected $want, got $got). Nothing was installed."
say "SHA-256 verified: $got"

if [ "${PLEXIFORM_DRY_RUN:-}" = 1 ]; then say "dry run: would install $name"; exit 0; fi

if [ "$os" = Linux ]; then
  mkdir -p "$HOME/.local/bin"
  mv "$tmp/$name" "$HOME/.local/bin/plexiform.AppImage"
  chmod +x "$HOME/.local/bin/plexiform.AppImage"
  say "installed ~/.local/bin/plexiform.AppImage (AppImages need libfuse2 on Ubuntu 22.04+)."
  say "Prefer a package? The release also has a .deb: https://github.com/$REPO/releases"
  say "Uninstall: rm ~/.local/bin/plexiform.AppImage"
  exit 0
fi

apps=${PLEXIFORM_APPLICATIONS_DIR:-/Applications}
if [ ! -w "$apps" ] && [ -z "${PLEXIFORM_APPLICATIONS_DIR:-}" ]; then apps=$HOME/Applications; fi
mkdir -p "$apps"

mkdir "$tmp/unzipped"
ditto -x -k "$tmp/$name" "$tmp/unzipped" || die "could not unzip $name"
app=$tmp/unzipped/Plexiform.app
[ -d "$app" ] || die "$name does not contain Plexiform.app"
id=$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist" 2>/dev/null || true)
[ "$id" = "$BUNDLE_ID" ] || die "unexpected bundle id '$id' (wanted $BUNDLE_ID). Nothing was installed."
xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
codesign -v "$app" 2>/dev/null || die "the app's code signature is invalid. Nothing was installed."

if pgrep -x Plexiform >/dev/null 2>&1; then
  say "asking the running Plexiform to quit"
  osascript -e 'tell application "Plexiform" to quit' >/dev/null 2>&1 || true
  sleep 3
fi
if [ -e "$apps/Plexiform.app" ]; then
  mkdir -p "$HOME/.Trash"
  old=$HOME/.Trash/Plexiform-$(date +%Y%m%d-%H%M%S).app
  mv "$apps/Plexiform.app" "$old"
  say "moved the previous version to $old"
fi
ditto "$app" "$apps/Plexiform.app" || die "could not copy the app into $apps"

say "installed $apps/Plexiform.app"
say "Uninstall: drag it from $apps to the Bin. Your settings and data are kept separately and are not removed."
open "$apps/Plexiform.app" || true
