#!/usr/bin/env bash
set -euo pipefail

{ # this ensures the entire script is downloaded before execution
ENIGMA_BRANCH=${ENIGMA_BRANCH:=master}
ENIGMA_INSTALL_DIR=${ENIGMA_INSTALL_DIR:=$HOME/enigma-bbs}
ENIGMA_SOURCE=${ENIGMA_SOURCE:=https://github.com/NuSkooler/enigma-bbs.git}
# enig-term, the optional browser terminal: yes/no answers the prompt ahead of
# time (unset asks, or means no when there is no terminal to ask on), and a
# version such as 0.1.0 installs that release instead of the latest
ENIGMA_INSTALL_ENIG_TERM=${ENIGMA_INSTALL_ENIG_TERM:=}
ENIGMA_ENIG_TERM_VERSION=${ENIGMA_ENIG_TERM_VERSION:=}
ENIG_TERM_INSTALLED=""
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

# enig-term, the browser terminal ENiGMA½ serves at /_enig/ws-term/. Optional,
# and asked about before anything is installed, so a long npm build does not
# sit waiting on the answer.
ask_enig_term() {
    local ANSWER="${ENIGMA_INSTALL_ENIG_TERM}"

    if [[ -z "$ANSWER" ]]; then
        printf "Install the enig-term web terminal? [y/N] "
        # piped from curl, stdin is this script: ask the terminal, as the menu
        # does. With none (cron, CI), the answer is the default.
        if ! read -r ANSWER 2>/dev/null < /dev/tty; then
            ANSWER=""
            printf "\n"
            log "No terminal to ask on; not installing enig-term (set ENIGMA_INSTALL_ENIG_TERM=yes to)."
        fi
    fi

    case "$ANSWER" in
        [yY]|[yY][eE][sS]) ENIGMA_INSTALL_ENIG_TERM=yes ;;
        *) ENIGMA_INSTALL_ENIG_TERM=no ;;
    esac
}

enig_term_fetch() {
    local URL=$1
    local OUT=$2

    if check_exists curl; then
        curl -fsSL "$URL" -o "$OUT"
    else
        wget -q "$URL" -O "$OUT"
    fi
}

enig_term_sha256() {
    if check_exists sha256sum; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif check_exists shasum; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        return 1
    fi
}

# Downloads into WORK_DIR and installs into ${ENIGMA_INSTALL_DIR}/ws-term.
# Returns non-zero if any step fails; nothing is copied into place until the
# download has passed its checksum.
enig_term_download_and_install() {
    local WORK_DIR=$1
    local REPO="NuSkooler/enig-term"
    local VERSION="${ENIGMA_ENIG_TERM_VERSION#v}"
    local DEST="${ENIGMA_INSTALL_DIR}/ws-term"

    if ! check_exists curl && ! check_exists wget; then
        log "ERROR: enig-term needs curl or wget to download it."
        return 1
    fi
    if ! check_exists tar; then
        log "ERROR: enig-term needs tar to unpack it."
        return 1
    fi
    if ! check_exists sha256sum && ! check_exists shasum; then
        log "ERROR: enig-term needs sha256sum (or shasum) to check the download."
        return 1
    fi

    if [[ -z "$VERSION" ]]; then
        log "Finding the latest enig-term release..."
        enig_term_fetch "https://api.github.com/repos/${REPO}/releases/latest" "${WORK_DIR}/latest.json" || return 1
        VERSION=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' "${WORK_DIR}/latest.json" | head -n 1)
        if [[ -z "$VERSION" ]]; then
            log "ERROR: Could not read the latest enig-term version from GitHub."
            return 1
        fi
    fi

    # it names a path below, so take nothing but a version number
    if [[ ! "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
        log "ERROR: '${VERSION}' is not an enig-term version."
        return 1
    fi

    local NAME="enig-term-${VERSION}"
    local BASE="https://github.com/${REPO}/releases/download/v${VERSION}"

    log "Downloading enig-term ${VERSION}..."
    enig_term_fetch "${BASE}/${NAME}.tar.gz" "${WORK_DIR}/${NAME}.tar.gz" || return 1
    enig_term_fetch "${BASE}/SHA256SUMS" "${WORK_DIR}/SHA256SUMS" || return 1

    local EXPECTED ACTUAL
    EXPECTED=$(awk -v f="${NAME}.tar.gz" '$2 == f || $2 == "*" f { print $1; exit }' "${WORK_DIR}/SHA256SUMS")
    ACTUAL=$(enig_term_sha256 "${WORK_DIR}/${NAME}.tar.gz") || return 1
    if [[ -z "$EXPECTED" ]]; then
        log "ERROR: SHA256SUMS has no entry for ${NAME}.tar.gz."
        return 1
    fi
    if [[ "$EXPECTED" != "$ACTUAL" ]]; then
        log "ERROR: ${NAME}.tar.gz failed its checksum (expected ${EXPECTED}, got ${ACTUAL})."
        return 1
    fi
    log "  Checksum OK."

    mkdir -p "${WORK_DIR}/unpack"
    tar -xzf "${WORK_DIR}/${NAME}.tar.gz" -C "${WORK_DIR}/unpack" || return 1
    if [[ ! -f "${WORK_DIR}/unpack/${NAME}/index.html" ]]; then
        log "ERROR: ${NAME}.tar.gz does not hold ${NAME}/index.html."
        return 1
    fi

    # a config.json in ws-term overrides the one ENiGMA½ generates: never
    # bring one in from a release, nor replace one the operator put there
    rm -f "${WORK_DIR}/unpack/${NAME}/config.json"

    mkdir -p "$DEST" || return 1
    cp -R "${WORK_DIR}/unpack/${NAME}/." "$DEST/" || return 1

    log "enig-term ${VERSION} installed in ${DEST}"
}

install_enig_term() {
    [[ "${ENIGMA_INSTALL_ENIG_TERM}" == "yes" ]] || return 0

    local WORK_DIR
    WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/enig-term.XXXXXX") || {
        log "ERROR: Could not create a temporary directory; enig-term was not installed."
        return 0
    }

    if enig_term_download_and_install "$WORK_DIR"; then
        ENIG_TERM_INSTALLED=yes
    else
        printf "%benig-term was not installed. The rest of the installation is unaffected; see\n  %s\nto install it by hand.%b\n" \
            "${FOREGROUND_STRONG_RED}" "https://enigma-bbs.github.io/servers/loginservers/enig-term/" "${RESET}"
    fi

    rm -rf "$WORK_DIR"
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

  zip/unzip: ZIP support, the most common upload format
    Debian/Ubuntu : apt-get install zip unzip
    CentOS        : yum install zip unzip

  unrar: RAR support. It must be RARLAB's unrar: unrar-free lists RARs in a
  layout ENiGMA cannot read, so every RAR looks empty
    Debian        : enable non-free, then apt-get install unrar
    Ubuntu        : enable multiverse, then apt-get install unrar
    CentOS        : yum install unrar (RPM Fusion nonfree)

  unarc: Reads ARC/PAK, ZOO, ACE, SQZ, UC2, .Z, xz, Zstandard, CAB, C64 and
  Amiga DMS files, and can stand in for unlzx and atr (LZX and ATR)
    Any           : cargo install --locked unarc-cli
                    (needs Rust 1.95 or later: https://rustup.rs, or with mise:
                     mise use -g rust, then the cargo command above. It
                     installs to ~/.cargo/bin, which must be in ENiGMA's PATH)

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

    if [[ -n "${ENIG_TERM_INSTALLED}" ]]; then
        cat << EndOfMessage
6 - enig-term web terminal

    enig-term is installed in:
        ${ENIGMA_INSTALL_DIR}/ws-term

    It needs the web server (contentServers.web) enabled, and a secure
    WebSocket (wss://) that browsers can reach. Behind a TLS proxy, set the
    public endpoint in config.hjson:

        contentServers: {
            web: {
                wsTerm: {
                    endpoint: "wss://your-hostname.here:44512"
                }
            }
        }

    Then browse to https://your-hostname.here/_enig/ws-term/

EndOfMessage
    fi
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
    ask_enig_term
    log "Installing ENiGMA½..."

    download_enigma_source
    copy_template_files
    download_v86_bios
    install_enig_term
}

install_everything() {
    ask_enig_term
    log "Installing Everything..."
    download_enigma_source
    install_dependencies
    copy_template_files
    download_v86_bios
    install_enig_term
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
