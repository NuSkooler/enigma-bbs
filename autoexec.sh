#!/bin/bash

# Activate Mise
eval "$(~/.local/bin/mise activate bash)"

# Start BBS
/home/egonis/enigma-bbs/main.js
result=$?

# Determine whether a Startup Crash Occurred
# if [ $result -eq 0 ]; then
# 	# TODO: Notify via SMS / Email of Startup Failure
# fi

echo "ENiGMA½ exited with $result"
exit $result
