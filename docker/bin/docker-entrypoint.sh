#!/usr/bin/env bash
set -e

# Set some vars
PRE_POP_VOLS=("config" "mods" "art") # these are folders which contain runtime needed files, and need to be represented in the host
BBS_ROOT=/enigma-bbs # install location
BBS_STG_P=/enigma-bbs-pre # staging location for pre populated volumes (PRE_POP_VOLS)
CONFIG_NAME=config.hjson # this is the default name, this script is intended for easy get-go - make changes as needed

# Setup happens when there is no existing config file
if [[ ! -f $BBS_ROOT/config/$CONFIG_NAME ]]; then
    for DIR in "${PRE_POP_VOLS[@]}"
    do
        if [ -n "$(find "$BBS_ROOT/$DIR" -maxdepth 0 -type d -empty 2>/dev/null)" ]; then
            cp -rp $BBS_STG_P/$DIR/* $BBS_ROOT/$DIR/
        else
            printf "WARN: skipped $BBS_ROOT/$DIR: Volume not empty or not a new setup; Files required to run ENiGMA 1/2 may be missing.\n Possible bad state\n"
            printf "INFO: You have mounted folders with existing data - but no existing config json.\n\nPossible solutions:\n1. Make sure all volumes are set correctly specifically config volume... \n2. Check your configuration name if non-default\n\n\n" 
        fi
    done
    ./oputil.js config new
fi
if [[ ! -f $BBS_ROOT/config/$CONFIG_NAME ]]; then #make sure once more, otherwise pm2-runtime will loop if missing the config
  printf "ERROR: Missing configuration - ENiGMA 1/2 will not work. please run config\n"
  
  exit 1
else
    pm2-runtime main.js
fi
