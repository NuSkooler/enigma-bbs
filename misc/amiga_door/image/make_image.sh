#!/usr/bin/env bash
#
# Build an ENiGMA½ Amiga door image (a bare FFS hard-disk image, volume BBS).
#
#   make_image.sh [-s SIZE] [-n VOLUME] [-x XDFTOOL] [-w ADF] [-p PFILEDIR]...
#                 [-c COMMAND]... [-f] IMAGE [DOORDIR...]
#
#   IMAGE      image file to create, e.g. ~/amiga/dreamsweeper.hdf
#   DOORDIR    a door's directory on this machine; its contents are copied to
#              Doors/<directory name>/ in the image, layout kept. Give several
#              to put several doors on one image.
#
#   -s SIZE    image size (default 2000K); anything xdftool's size= accepts.
#              Over 4066 blocks (2033K) the volume needs a second bitmap block,
#              which a stock AROS ROM's filesystem misreads: a door's writes then
#              overwrite other files. Stay at or under 2033K (2032K is the
#              largest multiple of 8K) if the image may run on a stock AROS ROM;
#              the bundled ROM (enigma-vamiga 0.1.2 and later) and Kickstart 3.1
#              handle any size.
#   -n VOLUME  volume name (default BBS)
#   -x PATH    xdftool to use (default: $XDFTOOL, else xdftool on PATH)
#   -w ADF     add ARexx, which ARexx (AIM) doors need and AROS does not have,
#              from your own Workbench 3.1 disk image: RexxMast, rexxsyslib and
#              rexxsupport.library, the IEEE math libraries rexxsyslib needs,
#              SYS:Rexxc and the C: commands scripts run with ADDRESS COMMAND.
#              Those files are licensed: the image is for your board only.
#   -p DIR     a C-Net ARexx door (pfile) directory: copied to PFiles/<name>/,
#              which the shim assigns PFILES: to; the image also gets C-Net's
#              mail tree CNet/Mail/Users (CNET: is SYS:CNet). Needs -w. Repeatable.
#   -c FILE    a command for C: (one a script runs with ADDRESS COMMAND, such as
#              QSort for Bad Libs). Repeatable.
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

size=2000K
# the most 512-byte blocks one bitmap block covers (127 longs x 32 bits, plus the two
# boot blocks): a stock AROS filesystem maps the blocks of any further bitmap block wrongly
one_bitmap_blocks=4066
volume=BBS
xdftool=${XDFTOOL:-xdftool}
force=0
workbench=
pfiles=()
commands=()

# what -w copies from the Workbench disk (same path on the disk and in the image)
wb_files=(
    System/RexxMast
    Libs/rexxsyslib.library Libs/rexxsupport.library
    Libs/mathieeedoubbas.library Libs/mathieeedoubtrans.library Libs/mathieeesingtrans.library
    Rexxc/RX Rexxc/RXC Rexxc/RXSET Rexxc/RXLIB Rexxc/HI Rexxc/TS Rexxc/TE Rexxc/TCO Rexxc/TCC
    Rexxc/WaitForPort
    C/Avail C/Copy C/Date C/Delete C/List C/MakeDir C/Rename C/Type C/Wait
)

usage() {
    sed -n '3,41p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-2}"
}

while getopts "s:n:x:w:p:c:fh" opt; do
    case $opt in
        s) size=$OPTARG ;;
        n) volume=$OPTARG ;;
        x) xdftool=$OPTARG ;;
        w) workbench=$OPTARG ;;
        p) pfiles+=("$OPTARG") ;;
        c) commands+=("$OPTARG") ;;
        f) force=1 ;;
        h) usage 0 ;;
        *) usage ;;
    esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || usage
[ $# -ge 2 ] || [ ${#pfiles[@]} -gt 0 ] || usage

image=$1
shift

# SIZE in bytes, when it is a plain number with an optional K, M or G (else empty)
size_bytes() {
    local n=${1%[KkMmGg]} unit=${1#"${1%[KkMmGg]}"}
    [[ $n =~ ^[0-9]+$ ]] || return 0
    case $unit in
        K | k) echo $((n * 1024)) ;;
        M | m) echo $((n * 1024 * 1024)) ;;
        G | g) echo $((n * 1024 * 1024 * 1024)) ;;
        *) echo "$n" ;;
    esac
}

bytes=$(size_bytes "$size")
if [ -n "$bytes" ] && [ "$bytes" -gt $((one_bitmap_blocks * 512)) ]; then
    echo "make_image.sh: warning: $size is over 4066 blocks (2033K) and needs a second bitmap block;" >&2
    echo "  a stock AROS ROM's filesystem then overwrites files when a door writes. Use -s 2033K or" >&2
    echo "  less if the image may run on a stock AROS ROM (the ROM bundled with enigma-vamiga 0.1.2" >&2
    echo "  and later, and Kickstart 3.1, handle any size)." >&2
fi

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

[ -z "$workbench" ] || [ -f "$workbench" ] || {
    echo "make_image.sh: no such Workbench disk image: $workbench" >&2
    exit 1
}

for d in "$@" ${pfiles[@]+"${pfiles[@]}"}; do
    [ -d "$d" ] || {
        echo "make_image.sh: not a directory: $d" >&2
        exit 1
    }
done

for f in ${commands[@]+"${commands[@]}"}; do
    [ -f "$f" ] || {
        echo "make_image.sh: no such file: $f" >&2
        exit 1
    }
done

[ ${#pfiles[@]} -eq 0 ] || [ -n "$workbench" ] || {
    echo "make_image.sh: C-Net ARexx doors (-p) need ARexx: give your Workbench 3.1 disk with -w" >&2
    exit 1
}

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

if [ -n "$workbench" ]; then
    wbdir=$(mktemp -d)
    trap 'rm -rf "$wbdir"' EXIT
    reads=("$workbench")
    for i in "${!wb_files[@]}"; do
        reads+=(read "${wb_files[$i]}" "$wbdir/$i" +)
    done
    unset 'reads[${#reads[@]}-1]'
    "$xdftool" "${reads[@]}" > /dev/null
    args+=(+ makedir System + makedir Rexxc)
    for i in "${!wb_files[@]}"; do
        [ -f "$wbdir/$i" ] || {
            echo "make_image.sh: ${wb_files[$i]} is not on $workbench (a Workbench 3.1 disk?)" >&2
            exit 1
        }
        args+=(+ write "$wbdir/$i" "${wb_files[$i]}")
    done
fi

for f in ${commands[@]+"${commands[@]}"}; do
    args+=(+ write "$f" "C/$(basename "$f")")
done

# copy_tree DIR ROOT: DIR's contents to ROOT in the image, layout kept
copy_tree() {
    local d=${1%/} root=$2 sub file
    args+=(+ makedir "$root")
    while IFS= read -r -d '' sub; do
        args+=(+ makedir "$root/${sub#./}")
    done < <(cd "$d" && find . -mindepth 1 -type d -print0 | sort -z)
    while IFS= read -r -d '' file; do
        args+=(+ write "$d/${file#./}" "$root/${file#./}")
    done < <(cd "$d" && find . -type f -print0 | sort -z)
}

for d in "$@"; do
    copy_tree "$d" "Doors/$(basename "${d%/}")"
done

if [ ${#pfiles[@]} -gt 0 ]; then
    # C-Net: PFILES: is SYS:PFiles and CNET: SYS:CNet (the shim assigns them); pfiles
    # keep per-caller files in CNET:Mail/Users/<account>/
    args+=(+ makedir PFiles + makedir CNet + makedir CNet/Mail + makedir CNet/Mail/Users)
    for d in "${pfiles[@]}"; do
        copy_tree "$d" "PFiles/$(basename "${d%/}")"
    done
fi

"$xdftool" "${args[@]}"
"$xdftool" "$image" list
