#!/bin/sh
# Puts `handover` on this machine.
#
#   curl -fsSL https://raw.githubusercontent.com/zihanyang-dev/handover/main/apps/cli/install.sh | sh
#
# One file, nothing to keep installed underneath it: no Node, no package manager, no runtime that
# can be upgraded out from under it. The machines this runs on are somebody's laptop and somebody's
# server, and the second one is the reason nothing here assumes a package manager is present.
#
# Every download is checked against the checksums published with the release. A binary that does
# not match is not installed and not left behind — a machine credential is minted by this program,
# so what it is matters more than that it arrives.

set -eu

REPO="${HANDOVER_REPO:-zihanyang-dev/handover}"
VERSION="${HANDOVER_VERSION:-latest}"
BIN_DIR="${HANDOVER_BIN_DIR:-/usr/local/bin}"

say() { printf '%s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

# What this machine is, in the words the release uses.
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "handover has no build for $(uname -s). It runs on macOS and Linux." ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "handover has no build for $(uname -m)." ;;
esac

# The release names its files this way; nothing else here needs to know about platforms.
asset="handover-$os-$arch"

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

command -v curl >/dev/null 2>&1 || die "this needs curl."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

say "downloading $asset ($VERSION)"
curl -fsSL "$base/$asset" -o "$work/handover" || die "could not download $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$work/SHA256SUMS" || die "could not download the checksums"

# The checksum file covers every asset in the release; only this one is here to check against it.
want="$(grep " $asset\$" "$work/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$want" ] || die "the release has no checksum for $asset"

if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$work/handover" | cut -d' ' -f1)"
else
  got="$(shasum -a 256 "$work/handover" | cut -d' ' -f1)"
fi

[ "$got" = "$want" ] || die "the download does not match its checksum. Nothing was installed."

chmod +x "$work/handover"

# Written where the person can reach it, and with sudo only if that is what it takes to get there.
if [ -w "$BIN_DIR" ]; then
  mv "$work/handover" "$BIN_DIR/handover"
else
  say "$BIN_DIR needs root; asking for it"
  sudo mv "$work/handover" "$BIN_DIR/handover"
fi

say "installed $("$BIN_DIR/handover" version) at $BIN_DIR/handover"
say ""
say "next: cd into the project you want it to work in, then run"
say "  handover connect"
