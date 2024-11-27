#!/usr/bin/env bash

LOGFILE_PATH=~/enigma-bbs/logs/enigma-bbs.log
BUNYAN_BINARY_PATH=~/enigma-bbs/node_modules/bunyan/bin/bunyan

PATH="$HOME/.local/share/mise/shims:$PATH"

tail -F $LOGFILE_PATH | $BUNYAN_BINARY_PATH
