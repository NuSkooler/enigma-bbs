#!/usr/bin/env bash

# Environment
ENIGMA_INSTALL_DIR=${ENIGMA_INSTALL_DIR:=$HOME/enigma-bbs}
AUTOEXEC_LOGFILE="$ENIGMA_INSTALL_DIR/logs/autoexec.log"
TIME_FORMAT=`date "+%Y-%m-%d %H:%M:%S"`

# Mise en place
export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.local/share/mise/shims:$PATH"
export PATH="$HOME/.local/share/mise/installs/python/latest/bin:$PATH"

# Environment Versions
ENIGMA_NODE_VERSION=${ENIGMA_NODE_VERSION:=$(toml get --toml-path=$ENIGMA_INSTALL_DIR/mise.toml tools.node)}
ENIGMA_PYTHON_VERSION=${ENIGMA_PYTHON_VERSION:=$(toml get --toml-path=$ENIGMA_INSTALL_DIR/mise.toml tools.python)}

# Validate Environment
DEPENDENCIES_VALIDATED=1

# Shared Functions
log() {
    echo "${TIME_FORMAT} " "$*" >> $AUTOEXEC_LOGFILE
}

# If this is a first run, the log path will not yet exist and must be created
if [ ! -d "$ENIGMA_INSTALL_DIR/logs" ]
then
    mkdir -p $ENIGMA_INSTALL_DIR/logs
fi

log "START:"
log "- PATH: $PATH"
log "- CURRENT DIR: ${PWD##}"

if ! command -v "mise" 2>&1 >/dev/null
then
    log "mise is not in your PATH"
    log "ERROR END"
    exit 1
fi

if ! command -v "node" 2>&1 >/dev/null
then
    log "Node environment is not in your PATH"
    log "ERROR END"
    exit 1
else
    NODE_VERSION=$(node --version | tee /dev/null)
    log "- NODE VERSION: $NODE_VERSION"
    if [[ $NODE_VERSION != "v$ENIGMA_NODE_VERSION."* ]]; then
        log "Node version found in your PATH is $NODE_VERSION, was expecting v$ENIGMA_NODE_VERSION.*; you may encounter compatibility issues"
        DEPENDENCIES_VALIDATED=0
    fi
fi

if ! command -v "python" 2>&1 >/dev/null
then
    log "Python environment is not in your PATH"
    log "ERROR END"
    exit 1
else
    PYTHON_VERSION=$(python --version | tee /dev/null)
    log "- PYTHON VERSION: $PYTHON_VERSION"
    if [[ $PYTHON_VERSION != "Python $ENIGMA_PYTHON_VERSION"* ]]; then
        log "Python version found in your PATH is $PYTHON_VERSION, was expecting Python $ENIGMA_PYTHON_VERSION.*; you may encounter compatibility issues"
        DEPENDENCIES_VALIDATED=0
    fi
fi

# Validate whether we are good to Start
if [ "$DEPENDENCIES_VALIDATED" == "0" ]; then
    if [ -v ENIGMA_IGNORE_DEPENDENCIES ] && [ "${ENIGMA_IGNORE_DEPENDENCIES}" == "1" ]; then
        log "ENIGMA_IGNORE_DEPENDENCIES=1 detected, starting up..."
    else
        log "NOTE: Please re-run with 'ENIGMA_IGNORE_DEPENDENCIES=1 /path/to/autoexec.sh' to force startup"
        log "ERROR END"
        exit 1
    fi
fi

# Start BBS
log "Starting ENiGMA½"
~/enigma-bbs/main.js
result=$?

# Determine whether a Startup Crash Occurred
# if [ $result -eq 0 ]; then
# 	# TODO: Notify via SMS / Email of Startup Failure
# fi

log "ENiGMA½ exited with $result"
log "END"
exit $result
