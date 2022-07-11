#!/usr/bin/env bash
set -e

# Set some vars
PRE_POPULATED_VOLUMES=("config" "mods" "art") # These are folders which contain runtime needed files, and need to be represented in the host
BBS_ROOT_DIR=/enigma-bbs # Install location
BBS_STAGING_PATH=/enigma-bbs-pre # Staging location for pre populated volumes (PRE_POPULATED_VOLUMES)
CONFIG_NAME=config.hjson # This is the default name, this script is intended for easy get-go - make changes as needed

# Setup happens when there is no existing config file
if [[ ! -f $BBS_ROOT_DIR/config/$CONFIG_NAME ]]; then
    for VOLUME in "${PRE_POPULATED_VOLUMES[@]}"
    do
        if [ -n "$(find "$BBS_ROOT_DIR/$VOLUME" -maxdepth 0 -type d -empty 2>/dev/null)" ]; then
            cp -rp $BBS_STAGING_PATH/$VOLUME/* $BBS_ROOT_DIR/$VOLUME/
        else
            printf "WARN: skipped $BBS_ROOT_DIR/$VOLUME: Volume not empty or not a new setup; Files required to run ENiGMA 1/2 may be missing.\n Possible bad state\n"
            printf "INFO: You have mounted folders with existing data - but no existing config json.\n\nPossible solutions:\n1. Make sure all volumes are set correctly specifically config volume... \n2. Check your configuration name if non-default\n\n\n" 
        fi
    done
    ./oputil.js config new
fi
if [[ ! -f $BBS_ROOT_DIR/config/$CONFIG_NAME ]]; then # Make sure once more, otherwise pm2-runtime will loop if missing the config
  printf "ERROR: Missing configuration - ENiGMA 1/2 will not work. please run config\n"
  
  exit 1
else
   exec pm2-runtime main.js 
fi
