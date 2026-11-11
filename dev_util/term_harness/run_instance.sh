#!/usr/bin/env bash
#  Start/stop the throwaway harness instance built by make_instance.js.
#  Usage: run_instance.sh start|stop|status [instanceDir]
#  Default instanceDir: .work/instance beside this script. Pid in <dir>/enigma.pid,
#  output in <dir>/enigma.out. Listens on 127.0.0.1 only (see make_instance.js).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CMD="${1:-}"
INST="$(realpath -m "${2:-$HERE/.work/instance}")"
PIDF="$INST/enigma.pid"

#  Alive only if the pid is still OUR instance: a stale pid file must never get
#  an unrelated process signalled once the pid has been reused.
alive() {
    [ -f "$PIDF" ] || return 1
    local pid; pid="$(cat "$PIDF")"
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null || return 1
    [ -r "/proc/$pid/cmdline" ] || return 1
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF -- "--config $INST/"
}

case "$CMD" in
start)
    [ -f "$INST/.term_harness_instance" ] || { echo "no harness instance at $INST (run make_instance.js first)"; exit 1; }
    alive && { echo "already running, pid $(cat "$PIDF")"; exit 0; }
    cd "$ROOT" || exit 1
    nohup node ./main.js --config "$INST/" > "$INST/enigma.out" 2>&1 &
    echo $! > "$PIDF"
    PORT="$(sed -n 's/^port=//p' "$INST/.term_harness_instance")"
    for _ in $(seq 1 60); do
        alive || { echo "instance died; see $INST/enigma.out"; exit 1; }
        (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && { echo "up: pid $(cat "$PIDF"), telnet 127.0.0.1:$PORT"; exit 0; }
        sleep 0.5
    done
    echo "timed out waiting for port $PORT; see $INST/enigma.out"; exit 1
    ;;
stop)
    alive || { echo "not running"; rm -f "$PIDF"; exit 0; }
    kill "$(cat "$PIDF")"
    for _ in $(seq 1 40); do alive || break; sleep 0.25; done
    alive && kill -9 "$(cat "$PIDF")"
    rm -f "$PIDF"; echo "stopped"
    ;;
status)
    alive && echo "running, pid $(cat "$PIDF")" || echo "not running"
    ;;
*)
    echo "usage: $0 start|stop|status [instanceDir]"; exit 2
    ;;
esac
