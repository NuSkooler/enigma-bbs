#!/usr/bin/env bash

{ # this ensures the entire script is downloaded before execution

ENIGMA_NODE_VERSION=${ENIGMA_NODE_VERSION:=6}
ENIGMA_INSTALL_DIR=${ENIGMA_INSTALL_DIR:=$HOME/enigma-bbs}
ENIGMA_SOURCE=${ENIGMA_SOURCE:=https://github.com/NuSkooler/enigma-bbs.git}
TIME_FORMAT=`date "+%Y-%m-%d %H:%M:%S"`
WAIT_BEFORE_INSTALL=10

enigma_header() {
    clear
    cat << EndOfMessage
                                                                     ______
_____________________   _____  ____________________    __________\\_   /
\\__   ____/\\_ ____   \\ /____/ /   _____ __         \\  /   ______/ // /___jp!
 //   __|___//   |    \\//   |//   |    \\//  |  |    \\//        \\ /___   /_____
/____       _____|      __________       ___|__|      ____|     \\   /  _____  \\
---- \\______\\ -- |______\\ ------ /______/ ---- |______\\ - |______\\ /__/ // ___/
                                                                       /__   _\\
       <*> ENiGMA½ // https://github.com/NuSkooler/enigma-bbs <*>        /__/

ENiGMA½ will be installed to ${ENIGMA_INSTALL_DIR}, from source ${ENIGMA_SOURCE}.

ENiGMA½ requires Node.js. Version ${ENIGMA_NODE_VERSION}.x current will be installed via nvm. If you already have nvm installed, this install script will update it to the latest version.

If this isn't what you were expecting, hit ctrl-c now. Installation will continue in ${WAIT_BEFORE_INSTALL} seconds...

EndOfMessage
    sleep ${WAIT_BEFORE_INSTALL}
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

    log "Checking Python installation"
    enigma_install_needs python
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
      exit 1
    fi
}

enigma_footer() {
    log "ENiGMA½ installation complete!"
    echo -e "\e[33m"
    cat << EndOfMessage
If this is the first time you've installed ENiGMA½, you now need to generate a minimal configuration. To do so, run the following commands:

  cd ${ENIGMA_INSTALL_DIR}
  ./oputil.js config --new

Additionally, the following support binaires are recommended:
  7zip: Archive support
    Debian/Ubuntu : apt-get install p7zip
    CentOS        : yum install p7zip

  Lha: Archive support
    Debian/Ubuntu : apt-get install lhasa

  Arj: Archive support
    Debian/Ubuntu : apt-get install arj

  sz/rz: Various X/Y/Z modem support
    Debian/Ubuntu : apt-get install lrzsz
    CentOS        : yum install lrzsz

EndOfMessage
    echo -e "\e[39m"
}

enigma_header
enigma_install_init
install_nvm
configure_nvm
download_enigma_source
install_node_packages
enigma_footer

} # this ensures the entire script is downloaded before execution