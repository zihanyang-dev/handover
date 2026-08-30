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

# A stock Apple Silicon Mac has no `/usr/local/bin` at all — Homebrew lives in `/opt/homebrew`
# and nothing else ever makes it. Without this, `[ -w ]` was false for a directory that did not
# exist, the script went to `sudo`, and `curl … | sh` sat there waiting for a password it had
# never said it wanted. Made without root wherever that is possible.
if [ ! -d "$BIN_DIR" ]; then
  if ! mkdir -p "$BIN_DIR" 2>/dev/null; then
    say "creating $BIN_DIR needs root; asking for it"
    sudo mkdir -p "$BIN_DIR" || die "could not create $BIN_DIR"
  fi
fi

# Written where the person can reach it, and with sudo only if that is what it takes to get there.
if [ -w "$BIN_DIR" ]; then
  mv "$work/handover" "$BIN_DIR/handover"
else
  # Said before it blocks, not after: `curl … | sh` that stops dead at an unexplained prompt
  # reads as a hung download.
  say "$BIN_DIR needs root; asking for it"
  sudo mv "$work/handover" "$BIN_DIR/handover" || die "could not write to $BIN_DIR"
fi

say "installed $("$BIN_DIR/handover" version) at $BIN_DIR/handover"

# A binary nobody can type the name of is a binary nobody has. Said rather than assumed: this
# may have landed somewhere sensible that this particular shell has never been told about.
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say ""
     say "$BIN_DIR is not on your PATH. Either add it, or run it by its full path:"
     say "  $BIN_DIR/handover" ;;
esac
say ""
# With the address on it. This build has no idea which Handover somebody means, and says so
# rather than guessing — so the line to run is the one on the page that sent them here.
say "next: open your Space, add a machine, and run the line it gives you. It looks like"
say "  handover connect --origin https://your-handover --key XXXX-XXXX"
