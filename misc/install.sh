#!/usr/bin/env bash

ENIGMA_NODE_VERSION=4.4
ENIGMA_INSTALL_DIR=$HOME/enigma-bbs
ENIGMA_SOURCE=https://github.com/NuSkooler/enigma-bbs.git
TIME_FORMAT=`date "+%Y-%m-%d %H:%M:%S"`

enigma_header() {
    cat << EndOfMessage
                                                                     ______
_____________________   _____  ____________________    __________\\_   /
\\__   ____/\\_ ____   \\ /____/ /   _____ __         \\  /   ______/ // /___jp!
 //   __|___//   |    \\//   |//   |    \\//  |  |    \\//        \\ /___   /_____
/____       _____|      __________       ___|__|      ____|     \\   /  _____  \\
---- \\______\\ -- |______\\ ------ /______/ ---- |______\\ - |______\\ /__/ // ___/
                                                                       /__   _\\
       <*> ENiGMA½ // https://github.com/NuSkooler/enigma-bbs <*>        /__/

This script will install Node 4.4 via nvm, download Enigma½, install its dependencies,
then run the config generator for you. If this isn't what you were expecting, hit ctrl-c now.

If you already have nvm installed, this will update it to the latest version.

EndOfMessage
    read -p ">> Hit Enter To Continue <<"
}

enigma_install_needs() {
    command -v $1 >/dev/null 2>&1 || { log_error "ENiGMA½ requires $1 but it's not installed. Please install it and restart the installer."; exit 1; }
}

log()  {
    printf "${TIME_FORMAT} %b\n" "$*";
}

log_error() {
    printf  "${TIME_FORMAT} \e[41mERROR:\033[0m %b\n" "$*" >&2;
}

enigma_install_init() {
    log "Checking git installation"
    enigma_install_needs git

    log "Checking curl installation"
    enigma_install_needs curl
}

install_nvm() {
    log "Installing nvm"
    curl -o- https://raw.githubusercontent.com/creationix/nvm/master/install.sh | bash
}

configure_nvm() {
    log "Installing Node ${ENIGMA_NODE_VERSION} via nvm"
    . ~/.nvm/nvm.sh
    nvm install ${ENIGMA_NODE_VERSION}
    nvm use ${ENIGMA_NODE_VERSION}
}

download_enigma_source() {
  local INSTALL_DIR
  INSTALL_DIR=${ENIGMA_INSTALL_DIR}

  if [ -d "$INSTALL_DIR/.git" ]; then
    log "ENiGMA½ is already installed in $INSTALL_DIR, trying to update using git"
    command git --git-dir="$INSTALL_DIR"/.git --work-tree="$INSTALL_DIR" fetch 2> /dev/null || {
      log_error "Failed to update ENiGMA½, run 'git fetch' in $INSTALL_DIR yourself."
      exit 1
    }
  else
    log "Downloading ENiGMA½ from git to '$INSTALL_DIR'"
    mkdir -p "$INSTALL_DIR"
    command git clone ${ENIGMA_SOURCE} "$INSTALL_DIR" || {
      log_error "Failed to clone ENiGMA½ repo. Please report this!"
      exit 1
    }
  fi
}

install_node_packages() {
    log "Installing required Node packages"
    cd ${ENIGMA_INSTALL_DIR}
    npm install
    if [ $? -eq 0 ]; then
      log "npm package installation complete"
    else
      log_error "Failed to install ENiGMA½ npm packages. Please report this!"
    fi
}

generate_enigma_config() {
    log "Launching config generator"
    cd ${ENIGMA_INSTALL_DIR}
    ./oputil.js config --new
}

enigma_footer() {
    log "ENiGMA½ installation complete!"
}

enigma_header
enigma_install_init
install_nvm
configure_nvm
download_enigma_source
install_node_packages
generate_enigma_config
enigma_footer