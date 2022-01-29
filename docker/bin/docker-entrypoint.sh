#!/usr/bin/env bash

# Set some vars
prepopvols=("config" "mods" "art") # these are folders which contain runtime needed files, and need to be represented in the host
bbspath=/enigma-bbs # install location
bbsstgp=/enigma-bbs-pre # staging location for prepopvals
configname=config.hjson # this is the default name, this script is intended for easy get-go - make changes as needed

# Setup happens when there is no existing config file
if [[ ! -f $bbspath/config/$configname ]]; then
    for dir in "${prepopvols[@]}"
    do
        if [ -n "$(find "$bbspath/$dir" -maxdepth 0 -type d -empty 2>/dev/null)" ]; then
            cp -rpn $bbsstgp/$dir/* $bbspath/$dir/
        else
            echo "WARN skipped $bbspath/$dir - vol Not empty/not a new setup - possible bad state"
        fi
    done
    ./oputil.js config new
fi
if [[ ! -f $bbspath/config/$configname ]]; then #make sure once more, otherwise pm2-runtime will loop if missing the config
  echo "for some reason you have skipped configuration - enigma will not work. please run config"
  exit 1
else
    pm2-runtime main.js
fi
