#!/usr/bin/env bash
set -euo pipefail

{ # this ensures the entire script is downloaded before execution
ENIGMA_BRANCH=${ENIGMA_BRANCH:=master}
ENIGMA_INSTALL_DIR=${ENIGMA_INSTALL_DIR:=$HOME/enigma-bbs}
ENIGMA_SOURCE=${ENIGMA_SOURCE:=https://github.com/NuSkooler/enigma-bbs.git}
TIME_FORMAT=$(date "+%Y-%m-%d %H:%M:%S")

# ANSI Codes
readonly RESET="\e[0m"
readonly BOLD="\e[1m"
readonly UNDERLINE="\e[4m"
readonly INVERSE="\e[7m"
readonly FOREGROUND_BLACK="\e[30m"
readonly FOREGROUND_RED="\e[31m"
readonly FOREGROUND_GREEN="\e[32m"
readonly FOREGROUND_YELLOW="\e[33m"
readonly FOREGROUND_BLUE="\e[34m"
readonly FOREGROUND_MAGENTA="\e[35m"
readonly FOREGROUND_CYAN="\e[36m"
readonly FOREGROUND_WHITE="\e[37m"
readonly BACKGROUND_BLACK="\e[40m"
readonly BACKGROUND_RED="\e[41m"
readonly BACKGROUND_GREEN="\e[42m"
readonly BACKGROUND_YELLOW="\e[43m"
readonly BACKGROUND_BLUE="\e[44m"
readonly BACKGROUND_MAGENTA="\e[45m"
readonly BACKGROUND_CYAN="\e[46m"
readonly BACKGROUND_WHITE="\e[47m"
readonly FOREGROUND_STRONG_BLACK="\e[90m"
readonly FOREGROUND_STRONG_RED="\e[91m"
readonly FOREGROUND_STRONG_GREEN="\e[92m"
readonly FOREGROUND_STRONG_YELLOW="\e[93m"
readonly FOREGROUND_STRONG_BLUE="\e[94m"
readonly FOREGROUND_STRONG_MAGENTA="\e[95m"
readonly FOREGROUND_STRONG_CYAN="\e[96m"
readonly FOREGROUND_STRONG_WHITE="\e[97m"
readonly BACKGROUND_STRONG_BLACK="\e[100m"
readonly BACKGROUND_STRONG_RED="\e[101m"
readonly BACKGROUND_STRONG_GREEN="\e[102m"
readonly BACKGROUND_STRONG_YELLOW="\e[103m"
readonly BACKGROUND_STRONG_BLUE="\e[104m"
readonly BACKGROUND_STRONG_MAGENTA="\e[105m"
readonly BACKGROUND_STRONG_CYAN="\e[106m"
readonly BACKGROUND_STRONG_WHITE="\e[107m"

trap 'printf "\n${FOREGROUND_STRONG_RED}Installation failed at line ${LINENO}. Check the output above for details.${RESET}\n" >&2' ERR

enigma_header() {
    clear
    printf "$FOREGROUND_STRONG_WHITE"
    cat << EndOfMessage
                                                                 ______
_____________________   _____  ____________________    __________\\_   /
\\__   ____/\\_ ____   \\ /____/ /   _____ __         \\  /   ______/ // /___jp!
 //   __|___//   |    \\//   |//   |    \\//  |  |    \\//        \\ /___   /_____
/____       _____|      __________       ___|__|      ____|     \\   /  _____  \\
---- \\______\\ -- |______\\ ------ /______/ ---- |______\\ - |______\\ /__/ // ___/
                                                                       /__   _\\
       <*> ENiGMA½ // https://github.com/NuSkooler/enigma-bbs <*>        /__/


ENiGMA½:
  Source     : ${ENIGMA_SOURCE} (${ENIGMA_BRANCH} branch)
  Destination: ${ENIGMA_INSTALL_DIR}

EndOfMessage
    printf "$RESET"
}

fatal_error() {
    log "${TIME_FORMAT} ERROR: %b\n $*" >&2;
    exit 1
}

check_exists() {
    command -v "$1" >/dev/null 2>&1
}

enigma_install_needs_ex() {
    log "Checking for '$1'...${RESET}"
    if check_exists "$1" ; then
        log " Found!"
    else
        fatal_error "ENiGMA½ requires '$1' but it was not found. Please install it and/or make sure it is in your path then restart the installer.\n\n$2"
    fi
}

enigma_install_needs() {
    enigma_install_needs_ex "$1" "Examples:\n  sudo apt install $1 # Debian/Ubuntu\n  sudo yum install $1 # CentOS"
}

log() {
    local LOG_CONTENT=$1

    local COLOUR=""
    case $LOG_CONTENT in
        "ERROR")
            COLOUR="${FOREGROUND_STRONG_RED}"
            ;;
        *)
            COLOUR="${FOREGROUND_GREEN}"
            ;;
    esac

    printf "${TIME_FORMAT} %b\n" "${COLOUR}${LOG_CONTENT}${RESET}";
}

enigma_install_init() {
    enigma_install_needs git
    enigma_install_needs curl
    enigma_install_needs_ex make "Examples:\n  sudo apt install build-essential # Debian/Ubuntu\n  sudo yum groupinstall 'Development Tools' # CentOS"
    enigma_install_needs make
    enigma_install_needs gcc
}

download_enigma_source() {
    local INSTALL_DIR
    INSTALL_DIR=${ENIGMA_INSTALL_DIR}

    if [[ -d "$INSTALL_DIR/.git" ]]; then
        log "ENiGMA½ is already installed in $INSTALL_DIR, trying to update using git..."
        command git --git-dir="$INSTALL_DIR"/.git --work-tree="$INSTALL_DIR" fetch 2> /dev/null ||
            fatal_error "Failed to update ENiGMA½, run 'git fetch' in $INSTALL_DIR yourself."
    else
        log "Downloading ENiGMA½ from git to '$INSTALL_DIR'"
        mkdir -p "$INSTALL_DIR"
        command git clone "${ENIGMA_SOURCE}" "$INSTALL_DIR" ||
            fatal_error "Failed to clone ENiGMA½ repo. Please report this!"
    fi
}

is_arch_arm() {
    local ARCH
    ARCH=$(uname -m)
    if [[ $ARCH == "arm"* ]]; then
        true
    else
        false
    fi
}

install_mise_en_place() {
    if ! check_exists "mise"; then
        log "Installing mise..."
        curl -fsSL https://mise.jdx.dev/install.sh | sh
        if ! grep -q 'mise activate bash' "${HOME}/.bashrc"; then
            echo 'eval "$(~/.local/bin/mise activate bash)"' >> "${HOME}/.bashrc"
        fi
    fi

    eval "$("$HOME/.local/bin/mise" activate bash)"
    export PATH="$HOME/.local/share/mise/shims:$PATH"
}

setup_runtime_versions() {
    log "Setting up Node 20 LTS and Python 3.11 via mise..."
    mise install node@20
    mise use -g node@20

    mise install python@3.11
    mise use -g python@3.11

    local PYBIN
    PYBIN="$(mise which python)"
    export npm_config_python="$PYBIN"
    export NODE_GYP_FORCE_PYTHON="$PYBIN"

    log "Runtime ready. Node: $(node -v), Python: $("$PYBIN" -V)"
}

install_tools() {
    local PYBIN
    PYBIN="$(mise which python 2>/dev/null || command -v python3)"
    "$PYBIN" -m pip install --user setuptools toml-cli || true
}

install_node_packages() {
    log "Installing required Node packages..."
    printf "Note that on some systems such as RPi, this can take a VERY long time. Be patient!\n"

    cd "${ENIGMA_INSTALL_DIR}"
    git checkout "${ENIGMA_BRANCH}"

    export HUSKY=0

    local -a extra_args=()
    if is_arch_arm; then
        extra_args+=(--build-from-source)
    fi

    rm -rf node_modules

    if [[ -f package-lock.json ]]; then
        npm ci "${extra_args[@]}"
    else
        npm install "${extra_args[@]}"
    fi

    log "npm package installation complete"
}

copy_template_files() {
    log "Copying Template Files to ${ENIGMA_INSTALL_DIR}/misc/gophermap"
    if [[ ! -f "$ENIGMA_INSTALL_DIR/gopher/gophermap" ]]; then
        cp "$ENIGMA_INSTALL_DIR/misc/gophermap" "$ENIGMA_INSTALL_DIR/gopher/gophermap"
    fi
}

download_v86_bios() {
    local BIOS_DIR="${ENIGMA_INSTALL_DIR}/misc/v86_bios"
    local V86_BIOS_BASE="https://github.com/copy/v86/raw/master/bios"

    log "Downloading v86 BIOS files to ${BIOS_DIR}..."
    mkdir -p "${BIOS_DIR}"

    for BIOS_FILE in seabios.bin vgabios.bin; do
        if [[ -f "${BIOS_DIR}/${BIOS_FILE}" ]]; then
            log "  ${BIOS_FILE} already present, skipping."
        else
            log "  Downloading ${BIOS_FILE}..."
            curl -fL "${V86_BIOS_BASE}/${BIOS_FILE}" -o "${BIOS_DIR}/${BIOS_FILE}" ||
                fatal_error "Failed to download ${BIOS_FILE} from ${V86_BIOS_BASE}"
        fi
    done

    log "v86 BIOS files ready."
}

enigma_footer() {
    log "ENiGMA½ installation complete!"
    printf "${FOREGROUND_YELLOW}"
    cat << EndOfMessage

ADDITIONAL ACTIONS ARE REQUIRED!
--------------------------------

1 - If you did not have Node.js and/or mise installed previous to this please open a new shell/terminal now!
  (!) Not doing so will prevent 'node' or 'python' commands from functioning.
  (!) To activate mise in your current shell without opening a new terminal:
      eval "\$(~/.local/bin/mise activate bash)"

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

4 - Start ENiGMA½ BBS!

    ./autoexec.sh

5 - Enable Automated Startup on Boot (optional)

    Create a file in /etc/systemd/system/bbs.service with the following contents:
        [Unit]
        Description=Enigma½ BBS

        [Install]
        WantedBy=multi-user.target

        [Service]
        ExecStart=/home/<YOUR_USERNAME>/enigma-bbs/autoexec.sh
        Type=simple
        User=<YOUR_USERNAME>
        Group=<YOUR_USERNAME>
        WorkingDirectory=/home/<YOUR_USERNAME>/enigma-bbs/
        Restart=on-failure

    Run 'sudo systemctl enable bbs.service'

EndOfMessage
    printf "${RESET}"
}

post_install() {
    MISE_SHIM_PATH_COMMAND='export PATH="$HOME/.local/share/mise/shims:$PATH"'
    if grep -Fxq "$MISE_SHIM_PATH_COMMAND" ~/.bashrc
    then
        log "Mise Shims found in your ~/.bashrc"
    else
        printf '%s\n' "$MISE_SHIM_PATH_COMMAND" >> ~/.bashrc
        log "Installed Mise Shims into your ~/.bashrc"
    fi
}

install_dependencies() {
    log "Installing Dependencies..."

    enigma_install_init
    download_enigma_source
    install_mise_en_place
    setup_runtime_versions
    install_tools
    install_node_packages
    post_install
}

install_bbs() {
    log "Installing ENiGMA½..."

    download_enigma_source
    copy_template_files
    download_v86_bios
}

install_everything() {
    log "Installing Everything..."
    download_enigma_source
    install_dependencies
    copy_template_files
    download_v86_bios
}

menu() {
    local title="Installation Options"
    local prompt="Select>"
    local options=(
        "Install Dependencies"
        "Install ENiGMA½"
        "Install Everything"
    )

    echo "$title"
    PS3="$prompt "
    select opt in "${options[@]}" "Quit"; do
        case "$REPLY" in
        1) enigma_install_init; install_dependencies; break;;
        2) install_bbs; break;;
        3) enigma_install_init; install_everything; break;;
        $((${#options[@]}+1))) printf "Goodbye!"; exit 0;;
        *) printf "${FOREGROUND_STRONG_RED}Invalid option.${RESET}\n";continue;;
        esac
    done < /dev/tty

    unset PS3
}

main() {
    enigma_header
    menu
    enigma_footer
}

main "$@"

} # this ensures the entire script is downloaded before execution
