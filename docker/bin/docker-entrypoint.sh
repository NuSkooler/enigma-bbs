#!/usr/bin/env bash
prepopvols=("config" "mods" "art")
bbspath=/enigma-bbs
bbsstgp=/enigma-bbs-pre
if [[ ! -f $bbspath/config/config.hjson ]]; then
    for dir in "${prepopvols[@]}"
    do
        if [ -n "$(find "$bbspath/$dir" -maxdepth 0 -type d -empty 2>/dev/null)" ]; then
            cp -rp $bbsstgp/$dir/* $bbspath/$dir/
        else
            echo "WARN skipped $bbspath/$dir - vol Not empty/not a new setup - possible bad state"
        fi
    done
    ./oputil.js config new
fi
pm2-runtime main.js