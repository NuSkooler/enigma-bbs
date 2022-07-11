#!/usr/bin/env bash

{ # this ensures the entire script is downloaded before execution

ENIGMA_NODE_VERSION=${ENIGMA_NODE_VERSION:=14}
ENIGMA_BRANCH=${ENIGMA_BRANCH:=master}
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


Installing ENiGMA½:
  Source     : ${ENIGMA_SOURCE} (${ENIGMA_BRANCH} branch)
  Destination: ${ENIGMA_INSTALL_DIR}
  Node.js    : ${ENIGMA_NODE_VERSION}.x via NVM (If you have NVM it will be updated to the latest version)

>> If this isn't what you were expecting, hit CTRL-C now!
>> Installation will continue in ${WAIT_BEFORE_INSTALL} seconds...

EndOfMessage

    SECS=10
    while [ $SECS -gt 0 ]; do
        echo -ne "${SECS}... "
        sleep 1
        ((SECS --))
    done
    echo ""
}

fatal_error() {
    printf  "${TIME_FORMAT} \e[41mERROR:\033[0m %b\n" "$*" >&2;
    exit 1
}

check_exists() {
    command -v $1 >/dev/null 2>&1 ;
}

enigma_install_needs_ex() {
    echo -ne "Checking for '$1'..."
    if check_exists $1 ; then
        echo " Found!"
    else
        echo ""
        fatal_error "ENiGMA½ requires '$1' but it was not found. Please install it and/or make sure it is in your path then restart the installer.\n\n$2"
    fi
}

enigma_install_needs_python() {
    echo -ne "Checking for a suitable Python installation..."
    if check_exists "python" || check_exists "python7" || check_exists "python3" ; then
        echo " Found!"
    else
        echo ""
        fatal_error "ENiGMA½ requires Python for node-gyp to build binaries. Please see https://www.npmjs.com/package/node-gyp for details."
    fi
}

enigma_install_needs() {
    enigma_install_needs_ex $1 "Examples:\n  sudo apt install $1 # Debian/Ubuntu\n  sudo yum install $1 # CentOS"
}

log()  {
    printf "${TIME_FORMAT} %b\n" "$*";
}

enigma_install_init() {
    enigma_install_needs git
    enigma_install_needs curl
    enigma_install_needs_python
    enigma_install_needs_ex make "Examples:\n  sudo apt install build-essential # Debian/Ubuntu\n  sudo yum groupinstall 'Development Tools' # CentOS"
    enigma_install_needs make
    enigma_install_needs gcc
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
        command git --git-dir="$INSTALL_DIR"/.git --work-tree="$INSTALL_DIR" fetch 2> /dev/null ||
            fatal_error "Failed to update ENiGMA½, run 'git fetch' in $INSTALL_DIR yourself."
    else
        log "Downloading ENiGMA½ from git to '$INSTALL_DIR'"
        mkdir -p "$INSTALL_DIR"
        command git clone ${ENIGMA_SOURCE} "$INSTALL_DIR" ||
            fatal_error "Failed to clone ENiGMA½ repo. Please report this!"
    fi
}

is_arch_arm() {
    local ARCH=`arch`
    if [[ $ARCH == "arm"* ]]; then
        true
    else
        false
    fi
}

extra_npm_install_args() {
    if is_arch_arm ; then
        echo "--build-from-source"
    else
        echo ""
    fi
}

install_node_packages() {
    log "Installing required Node packages..."
    log "Note that on some systems such as RPi, this can take a VERY long time. Be patient!"

    cd ${ENIGMA_INSTALL_DIR}
    local EXTRA_NPM_ARGS=$(extra_npm_install_args)
    git checkout ${ENIGMA_BRANCH} && npm install ${EXTRA_NPM_ARGS}
    if [ $? -eq 0 ]; then
        log "npm package installation complete"
    else
        fatal_error "Failed to install ENiGMA½ npm packages. Please report this!"
    fi
}

copy_template_files() {
    if [[ ! -f "./gopher/gophermap" ]]; then
        cp "./misc/gophermap" "./gopher/gophermap"
    fi
}

enigma_footer() {
    log "ENiGMA½ installation complete!"
    echo -e "\e[1;33m"
    cat << EndOfMessage

ADDITIONAL ACTIONS ARE REQUIRED!
--------------------------------

1 - If you did not have Node.js and/or NVM installed previous to this please open a new shell/terminal now!
  (!) Not doing so will prevent 'nvm' or 'node' commands from functioning!

2 - If this is the first time you've installed ENiGMA½, you now need to generate a minimal configuration:

  cd ${ENIGMA_INSTALL_DIR}
  ./oputil.js config new

3 - Additionally, a minimum of the following support binaires are recommended:
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

  See docs for more information including other useful binaries!

EndOfMessage
    echo -e "\e[39m"
}

enigma_header
enigma_install_init
install_nvm
configure_nvm
download_enigma_source
install_node_packages
copy_template_files
enigma_footer

} # this ensures the entire script is downloaded before execution
