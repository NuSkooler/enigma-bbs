#!/bin/bash

# Setup Node Environment
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
nvm use 18

# Setup Python Environment
export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
pyenv local 3.10

# Start BBS
/home/egonis/enigma-bbs/main.js
result=$?

# Determine whether a Startup Crash Occurred
if [ $result -eq 0 ]; then
	echo "$result"
else
	echo "FAIL: ENiGMA½ exited with $result"

	# TODO: Notify via SMS / Email of Startup Failure
fi
