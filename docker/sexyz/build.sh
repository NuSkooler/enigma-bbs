#!/usr/bin/env bash
#
#  Build the SEXYZ binaries shipped in the Docker image, one per published
#  platform, from Synchronet's own source.
#
#      docker/sexyz/build.sh [--check]
#
#  With no arguments it clones Synchronet, cuts the stand-alone sexyz source,
#  cross compiles amd64 / arm64 / armv7 into docker/bin/, and rewrites
#  docker/sexyz/manifest.json.  With --check it stops after computing the
#  upstream source digest and exits 0 when the manifest already matches, 1
#  when a rebuild is due -- which is what the refresh workflow tests.
#
#  Everything happens inside a debian:bookworm container, because the runtime
#  base image is bookworm: building against a newer glibc produces binaries
#  the image cannot run.  Cross compilers rather than QEMU, so this takes
#  about a minute rather than twenty.
#
set -euo pipefail

UPSTREAM=${SEXYZ_UPSTREAM:-https://github.com/SynchronetBBS/sbbs.git}
REF=${SEXYZ_REF:-master}
REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
MANIFEST="$REPO_ROOT/docker/sexyz/manifest.json"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

echo "==> cloning $UPSTREAM ($REF)"
git clone --quiet --depth 1 --branch "$REF" "$UPSTREAM" "$WORK/sbbs"
UPSTREAM_COMMIT=$(git -C "$WORK/sbbs" rev-parse HEAD)

#  mksexyzsrc.sh runs `gcc -MM` over the sources before it writes its own
#  pinned copies of these two, so the dependency scan needs them to exist.
#  A real Synchronet build generates them the same way.
printf '#define GIT_BRANCH "%s"\n' "$REF" > "$WORK/sbbs/src/sbbs3/git_branch.h"
printf '#define GIT_HASH "0000000000"\n#define GIT_DATE "Jan 01 1970 00:00"\n#define GIT_TIME 0\n' \
    > "$WORK/sbbs/src/sbbs3/git_hash.h"

echo "==> cutting the stand-alone source"
bash "$WORK/sbbs/src/sbbs3/sexyz_release/mksexyzsrc.sh" "$WORK/sbbs" "$WORK/cut" >/dev/null
mkdir -p "$WORK/src"
tar xzf "$WORK"/cut/*_src.tgz -C "$WORK/src"

#  The digest is over the build inputs only.  git_branch.h and git_hash.h are
#  commit stamps regenerated on every upstream push, so including them would
#  make every Synchronet commit look like a sexyz change and rebuild binaries
#  that differ by a version string.
source_digest() {
    ( cd "$1" && find . -maxdepth 1 \( -name '*.c' -o -name '*.h' \) \
        ! -name 'git_branch.h' ! -name 'git_hash.h' -printf '%f\n' \
        | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1 )
}
DIGEST=$(source_digest "$WORK/src")
VERSION=$(sed -n 's/^const char\* *revision *= *"\([0-9.]*\)".*/\1/p' "$WORK/src/sexyz.c" | head -1)

RECORDED=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['source_digest'])" "$MANIFEST" 2>/dev/null || echo "")
echo "==> sexyz $VERSION  upstream $UPSTREAM_COMMIT"
echo "    source digest ${DIGEST}"
echo "    recorded      ${RECORDED:-<none>}"

if [ "$DIGEST" = "$RECORDED" ]; then
    echo "==> up to date"
    [ "$CHECK_ONLY" = 1 ] && exit 0
    exit 0
fi
if [ "$CHECK_ONLY" = 1 ]; then
    echo "==> rebuild due"
    exit 1
fi

cat > "$WORK/compile.sh" <<'INNER'
#!/bin/bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    build-essential crossbuild-essential-arm64 crossbuild-essential-armhf >/dev/null
cd /src
#  strlcpy/strlcat only entered glibc in 2.38.  xpdev carries its own behind
#  NEEDS_STRLCPY, which the stand-alone makefile never defines, so on bookworm
#  (2.36) the link fails without it.  Probe rather than hard-code: upstream may
#  fix this, and a newer builder image would not need it.
probe() {
    printf '#include <string.h>\nint main(void){char d[4];strlcpy(d,"x",4);strlcat(d,"y",4);return 0;}\n' > /tmp/probe.c
    "$1" /tmp/probe.c -o /tmp/probe 2>/dev/null && echo "" || echo "-DNEEDS_STRLCPY"
}
for spec in "amd64:cc:" "arm64:aarch64-linux-gnu-gcc:aarch64-linux-gnu-" "armv7:arm-linux-gnueabihf-gcc:arm-linux-gnueabihf-"; do
    arch="${spec%%:*}"; rest="${spec#*:}"; cc="${rest%%:*}"; prefix="${rest#*:}"
    extra=$(probe "$cc")
    echo "--- $arch ($cc${extra:+ $extra})"
    make clean >/dev/null 2>&1 || true
    #  Folded into CC, not CFLAGS: the makefile appends -I. and its own DEFS to
    #  CFLAGS, so overriding CFLAGS drops the include path.
    make CC="$cc $extra" -j"$(nproc)" >/dev/null
    mv sexyz "/out/sexyz-$arch"
    "${prefix}strip" "/out/sexyz-$arch"
done
make clean >/dev/null 2>&1 || true
INNER

mkdir -p "$WORK/out"
echo "==> cross compiling"
docker run --rm \
    -v "$WORK/src:/src" -v "$WORK/out:/out" -v "$WORK/compile.sh:/compile.sh:ro" \
    debian:bookworm bash /compile.sh

for a in amd64 arm64 armv7; do
    [ -s "$WORK/out/sexyz-$a" ] || { echo "missing build output for $a" >&2; exit 1; }
    install -m 755 "$WORK/out/sexyz-$a" "$REPO_ROOT/docker/bin/sexyz-$a"
done

python3 - "$MANIFEST" "$UPSTREAM" "$UPSTREAM_COMMIT" "$VERSION" "$DIGEST" "$REPO_ROOT" <<'PY'
import hashlib, json, sys, datetime
manifest, upstream, commit, version, digest, root = sys.argv[1:7]
def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()
json.dump({
    "_comment": "Generated by docker/sexyz/build.sh -- do not edit by hand.",
    "upstream": upstream,
    "upstream_commit": commit,
    "sexyz_version": version,
    "source_digest": digest,
    "built_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "builder_image": "debian:bookworm",
    "binaries": {a: sha(f"{root}/docker/bin/sexyz-{a}") for a in ("amd64", "arm64", "armv7")},
}, open(manifest, "w"), indent=4)
open(manifest, "a").write("\n")
PY

echo "==> done"
sed -n '1,40p' "$MANIFEST"
