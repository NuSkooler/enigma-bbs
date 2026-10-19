#!/bin/sh
# build.sh - build bin/axshim and bin/AEDoor.library from clean with bebbo's
# m68k-amigaos-gcc in Docker (amigadev/crosstools:m68k-amigaos), then show their
# hunks.  Sysops do not need this: both binaries are committed in ../bin.
#
# Usage: misc/amiga_door/shim/build.sh [make targets]     (default: clean all)
# Env:   IMAGE     the toolchain image (default amigadev/crosstools:m68k-amigaos)
#        HUNKTOOL  amitools' hunktool (default: hunktool on PATH; skipped if missing)
#
# Copyright (c) 2026, Bryan Ashby (NuSkooler)
# SPDX-License-Identifier: BSD-2-Clause
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(cd "$HERE/.." && pwd)
IMAGE=${IMAGE:-amigadev/crosstools:m68k-amigaos}
TARGETS=${*:-clean all}

docker run --rm -u "$(id -u):$(id -g)" -v "$TOP":/work -w /work/shim "$IMAGE" make $TARGETS

ls -l "$TOP/bin/axshim" "$TOP/bin/AEDoor.library"
sha256sum "$TOP/bin/axshim" "$TOP/bin/AEDoor.library"
HT=${HUNKTOOL:-hunktool}
if command -v "$HT" >/dev/null 2>&1; then
    for f in axshim AEDoor.library; do
        echo "== hunktool info bin/$f"
        "$HT" info "$TOP/bin/$f" || true     # hunktool exits 1 even when it succeeds
    done
else
    echo "(hunktool not found; set HUNKTOOL= to amitools' hunktool to list the hunks)"
fi
