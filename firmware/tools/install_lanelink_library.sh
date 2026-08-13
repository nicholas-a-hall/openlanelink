#!/usr/bin/env bash
#
# Makes firmware/lib/lanelink visible to the Arduino IDE / arduino-cli, so
# every openlanelink sketch can `#include <lanelink_protocol.h>`.
#
# The Arduino IDE only finds libraries inside your sketchbook's libraries/
# folder, so this links (never copies) this repo's lanelink library into it.
# Linking rather than copying is the whole point: edit the header in the repo
# and every sketch picks it up on the next compile, with no copy to forget.
#
#   bash firmware/tools/install_lanelink_library.sh           # install/repair
#   bash firmware/tools/install_lanelink_library.sh --check    # verify only
#
# macOS and Linux only. ON WINDOWS, USE install_lanelink_library.ps1 INSTEAD --
# not merely for convenience: the install has to replace an existing junction,
# and the POSIX tools available under Git Bash/MSYS handle Windows reparse
# points inconsistently. Getting that wrong deletes the contents of what the
# junction POINTS AT, which here is this repo's own source of truth. The
# PowerShell script deletes the link itself explicitly and can't make that
# mistake. This script refuses to run there rather than gamble.
#
# Sketchbook location is auto-detected (~/Documents/Arduino on macOS,
# ~/Arduino on Linux). Override with ARDUINO_SKETCHBOOK or pass the path as
# an argument:
#
#   ARDUINO_SKETCHBOOK=/path/to/sketchbook bash firmware/tools/install_lanelink_library.sh

set -uo pipefail

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "FAIL this script is macOS/Linux only -- on Windows run instead:"
    echo "       powershell -ExecutionPolicy Bypass -File firmware\\tools\\install_lanelink_library.ps1"
    echo "     (see this script's header comment for why it refuses rather than trying)"
    exit 1
    ;;
esac

cd "$(dirname "$0")/.." || exit 1
SOURCE_DIR="$(pwd)/lib/lanelink"

CHECK_ONLY=0
SKETCHBOOK_ARG=""
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) SKETCHBOOK_ARG="$arg" ;;
  esac
done

detect_sketchbook() {
  if [[ -n "${SKETCHBOOK_ARG}" ]]; then echo "$SKETCHBOOK_ARG"; return; fi
  if [[ -n "${ARDUINO_SKETCHBOOK:-}" ]]; then echo "$ARDUINO_SKETCHBOOK"; return; fi
  case "$(uname -s)" in
    Linux) echo "$HOME/Arduino" ;;
    *)     echo "$HOME/Documents/Arduino" ;;   # macOS
  esac
}

SKETCHBOOK="$(detect_sketchbook)"
LIB_DIR="$SKETCHBOOK/libraries"
TARGET="$LIB_DIR/lanelink"

if [[ ! -f "$SOURCE_DIR/library.properties" ]]; then
  echo "FAIL cannot find the lanelink library at $SOURCE_DIR"
  exit 1
fi

# Resolves to the same place? Compare a marker file's content rather than
# path strings -- junctions, symlinks, and drive-letter casing all differ
# textually while pointing at the same bytes.
links_to_source() {
  [[ -f "$TARGET/library.properties" ]] &&
    cmp -s "$TARGET/library.properties" "$SOURCE_DIR/library.properties" &&
    [[ -f "$TARGET/src/lanelink_protocol.h" ]] &&
    cmp -s "$TARGET/src/lanelink_protocol.h" "$SOURCE_DIR/src/lanelink_protocol.h"
}

if [[ $CHECK_ONLY -eq 1 ]]; then
  if links_to_source; then
    echo "OK   lanelink library installed and current"
    echo "     $TARGET -> $SOURCE_DIR"
    exit 0
  fi
  if [[ -e "$TARGET" ]]; then
    echo "FAIL $TARGET exists but does not match $SOURCE_DIR"
    echo "     A stale copy will compile happily and misparse on the wire."
    echo "     Re-run without --check to repair."
  else
    echo "FAIL lanelink library is not installed ($TARGET missing)"
    echo "     Sketches will fail with: lanelink_protocol.h: No such file or directory"
    echo "     Re-run without --check to install."
  fi
  exit 1
fi

if links_to_source; then
  echo "OK   lanelink library already installed at $TARGET"
  exit 0
fi

mkdir -p "$LIB_DIR" || { echo "FAIL could not create $LIB_DIR"; exit 1; }

if [[ -L "$TARGET" ]]; then
  # A symlink: unlink it, never recurse into it -- recursing would delete the
  # contents of what it points at, i.e. this repo's own source of truth.
  echo "     removing stale symlink $TARGET"
  rm -f "$TARGET"
elif [[ -e "$TARGET" ]]; then
  # A real directory: a hand-made copy from a previous install. Safe to
  # recurse, since there's no link to follow.
  echo "     removing stale copy $TARGET"
  rm -rf "$TARGET"
fi

ln -s "$SOURCE_DIR" "$TARGET"

if links_to_source; then
  echo "OK   lanelink library installed"
  echo "     $TARGET -> $SOURCE_DIR"
  echo "     Sketches can now #include <lanelink_protocol.h>."
  echo "     Restart the Arduino IDE if it was already open."
  exit 0
fi

echo "FAIL could not link $TARGET -> $SOURCE_DIR"
echo "     Fall back to copying it by hand:"
echo "       cp -r \"$SOURCE_DIR\" \"$TARGET\""
echo "     (a copy works, but you must re-copy after every protocol edit)"
exit 1
