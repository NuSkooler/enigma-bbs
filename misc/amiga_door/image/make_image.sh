#!/usr/bin/env bash
#
# Build an ENiGMA½ Amiga door image (a bare FFS hard-disk image, volume BBS).
#
#   make_image.sh [-s SIZE] [-n VOLUME] [-x XDFTOOL] [-f] IMAGE DOORDIR...
#
#   IMAGE      image file to create, e.g. ~/amiga/dreamsweeper.hdf
#   DOORDIR    a door's directory on this machine; its contents are copied to
#              Doors/<directory name>/ in the image, layout kept. Give several
#              to put several doors on one image.
#
#   -s SIZE    image size (default 4M); anything xdftool's size= accepts
#   -n VOLUME  volume name (default BBS)
#   -x PATH    xdftool to use (default: $XDFTOOL, else xdftool on PATH)
#   -f         replace IMAGE if it exists
#
# xdftool comes from amitools:
#   python3 -m venv ~/amitools-venv && ~/amitools-venv/bin/pip install amitools
#   XDFTOOL=~/amitools-venv/bin/xdftool misc/amiga_door/image/make_image.sh ...
#
# The image gets C/axshim, Libs/AEDoor.library and S/Startup-Sequence from this
# checkout, then the doors. Empty files are kept (some doors need an empty data
# file to exist). See README.md in this directory.
#
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
amiga_dir=$(dirname "$here")

size=4M
volume=BBS
xdftool=${XDFTOOL:-xdftool}
force=0

usage() {
    sed -n '3,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-2}"
}

while getopts "s:n:x:fh" opt; do
    case $opt in
        s) size=$OPTARG ;;
        n) volume=$OPTARG ;;
        x) xdftool=$OPTARG ;;
        f) force=1 ;;
        h) usage 0 ;;
        *) usage ;;
    esac
done
shift $((OPTIND - 1))
[ $# -ge 2 ] || usage

image=$1
shift

command -v "$xdftool" > /dev/null 2>&1 || [ -x "$xdftool" ] || {
    echo "make_image.sh: xdftool not found (pip install amitools, then use -x or XDFTOOL)" >&2
    exit 1
}

for f in bin/axshim bin/AEDoor.library image/Startup-Sequence; do
    [ -f "$amiga_dir/$f" ] || {
        echo "make_image.sh: missing $amiga_dir/$f" >&2
        exit 1
    }
done

for d in "$@"; do
    [ -d "$d" ] || {
        echo "make_image.sh: not a directory: $d" >&2
        exit 1
    }
done

if [ -e "$image" ]; then
    if [ "$force" -eq 1 ]; then
        rm -f -- "$image"
    else
        echo "make_image.sh: $image exists (use -f to replace it)" >&2
        exit 1
    fi
fi

args=(
    "$image" create "size=$size" + format "$volume" ffs
    + makedir C + makedir S + makedir Libs + makedir Doors
    + write "$amiga_dir/bin/axshim" C/axshim
    + write "$amiga_dir/bin/AEDoor.library" Libs/AEDoor.library
    + write "$here/Startup-Sequence" S/Startup-Sequence
)

for d in "$@"; do
    d=${d%/}
    root=Doors/$(basename "$d")
    args+=(+ makedir "$root")
    while IFS= read -r -d '' sub; do
        args+=(+ makedir "$root/${sub#./}")
    done < <(cd "$d" && find . -mindepth 1 -type d -print0 | sort -z)
    while IFS= read -r -d '' file; do
        args+=(+ write "$d/${file#./}" "$root/${file#./}")
    done < <(cd "$d" && find . -type f -print0 | sort -z)
done

"$xdftool" "${args[@]}"
"$xdftool" "$image" list
