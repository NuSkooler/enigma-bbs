#!/usr/bin/env bash

# Environment
ENIGMA_INSTALL_DIR=${ENIGMA_INSTALL_DIR:=$HOME/enigma-bbs}
AUTOEXEC_LOGFILE="$ENIGMA_INSTALL_DIR/logs/autoexec.log"

# Mise en place
~/.local/bin/mise activate bash >> bash

# Environment Versions
ENIGMA_NODE_VERSION=${ENIGMA_NODE_VERSION:=$(toml get --toml-path=$ENIGMA_INSTALL_DIR/mise.toml tools.node)}
ENIGMA_PYTHON_VERSION=${ENIGMA_PYTHON_VERSION:=$(toml get --toml-path=$ENIGMA_INSTALL_DIR/mise.toml tools.python)}

# Validate Environment
DEPENDENCIES_VALIDATED=1

echo "$(date '+%Y-%m-%d %H:%M:%S') - START:" | tee -a $AUTOEXEC_LOGFILE
echo "$(date '+%Y-%m-%d %H:%M:%S') - PATH: $PATH" | tee -a $AUTOEXEC_LOGFILE
echo "$(date '+%Y-%m-%d %H:%M:%S') - CURRENT DIR: ${PWD##}" | tee -a $AUTOEXEC_LOGFILE

if ! command -v "mise" 2>&1 >/dev/null
then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - mise is not in your PATH, activating" | tee -a $AUTOEXEC_LOGFILE
    eval "$(~/.local/bin/mise activate bash)"
fi

if ! command -v "node" 2>&1 >/dev/null
then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Node environment is not in your PATH" | tee -a $AUTOEXEC_LOGFILE
    echo "$(date '+%Y-%m-%d %H:%M:%S') - ERROR END" | tee -a $AUTOEXEC_LOGFILE
    exit 1
else
    NODE_VERSION=$(node --version | tee /dev/null)
    echo "$(date '+%Y-%m-%d %H:%M:%S') - NODE VERSION: $NODE_VERSION" | tee -a $AUTOEXEC_LOGFILE
    if [[ $NODE_VERSION != "v$ENIGMA_NODE_VERSION."* ]]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - Node version found in your PATH is $NODE_VERSION, was expecting v$ENIGMA_NODE_VERSION.*; you may encounter compatibility issues" | tee -a $AUTOEXEC_LOGFILE
        DEPENDENCIES_VALIDATED=0
    fi
fi

if ! command -v "python" 2>&1 >/dev/null
then
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Python environment is not in your PATH"
    echo "$(date '+%Y-%m-%d %H:%M:%S') - ERROR END" | tee -a $AUTOEXEC_LOGFILE
    exit 1
else
    PYTHON_VERSION=$(python --version | tee /dev/null)
    echo "$(date '+%Y-%m-%d %H:%M:%S') - PYTHON VERSION: $PYTHON_VERSION" | tee -a $AUTOEXEC_LOGFILE
    if [[ $PYTHON_VERSION != "Python $ENIGMA_PYTHON_VERSION"* ]]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - Python version found in your PATH is $PYTHON_VERSION, was expecting Python $ENIGMA_PYTHON_VERSION.*; you may encounter compatibility issues" | tee -a $AUTOEXEC_LOGFILE
        DEPENDENCIES_VALIDATED=0
    fi
fi

# Validate whether we are good to Start
if [ "$DEPENDENCIES_VALIDATED" == "0" ]; then
    if [ -v ENIGMA_IGNORE_DEPENDENCIES ] && [ "${ENIGMA_IGNORE_DEPENDENCIES}" == "1" ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') - ENIGMA_IGNORE_DEPENDENCIES=1 detected, starting up..." | tee -a $AUTOEXEC_LOGFILE
    else
        echo "$(date '+%Y-%m-%d %H:%M:%S') - NOTE: Please re-run with 'ENIGMA_IGNORE_DEPENDENCIES=1 /path/to/autoexec.sh' to force startup" | tee $AUTOEXEC_LOGFILE
        echo "$(date '+%Y-%m-%d %H:%M:%S') - ERROR END" | tee -a $AUTOEXEC_LOGFILE
        exit 1
    fi
fi

# Start BBS
echo "$(date '+%Y-%m-%d %H:%M:%S') - Starting ENiGMA½" | tee -a $AUTOEXEC_LOGFILE
~/enigma-bbs/main.js
result=$?

# Determine whether a Startup Crash Occurred
# if [ $result -eq 0 ]; then
# 	# TODO: Notify via SMS / Email of Startup Failure
# fi

echo "$(date '+%Y-%m-%d %H:%M:%S') - ENiGMA½ exited with $result" | tee -a $AUTOEXEC_LOGFILE
echo "$(date '+%Y-%m-%d %H:%M:%S') - END" | tee -a $AUTOEXEC_LOGFILE
exit $result
