#!/usr/bin/env bash
#
#  Drive automatic area creation against a REAL running ENiGMA½ instance.
#
#  Starts ./main.js against a throwaway configuration tree -- its own
#  databases, log, mail spool and ports -- so nothing here touches your own
#  board. See README.md.
#
set -u
set +m   #  no job-control chatter when the instance is stopped

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
DRILL="${1:-/tmp/enigma-ftn-drill}"
MENU="${2:-}"

if [[ -z "$MENU" ]]; then
    MENU="$(ls "$ROOT"/config/menus/*-main.hjson 2>/dev/null | head -1)"
fi
if [[ -z "$MENU" || ! -f "$MENU" ]]; then
    echo "Could not find a menu file. Pass one:  run.sh <drillDir> <path/to/menu.hjson>"
    exit 2
fi

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
logs() {
    cat "$DRILL"/logs/*.log 2>/dev/null | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
d.split('\n').filter(Boolean).forEach(l=>{try{const j=JSON.parse(l);
 if(new RegExp(process.argv[1],'i').test(j.msg||''))
  console.log('  ['+(j.level>=40?'warn':'info')+']', j.msg,
    (j.areaTag?' '+j.areaTag:''), (j.status?' '+j.status:''),
    (j.raw?' '+JSON.stringify(j.raw):''));
}catch(e){}});});" "$1"
}
toss() { date > "$DRILL/trigger/import.now"; sleep "${1:-8}"; }

stop() { pkill -f "main.js --config $DRILL" >/dev/null 2>&1; sleep 2; }
trap stop EXIT

say "Preparing $DRILL"
stop
rm -rf "$DRILL"; mkdir -p "$DRILL"
node "$HERE/setup.js" "$DRILL" "$MENU"       || exit 1
node "$ROOT/oputil.js" mb auto-areas init --config "$DRILL/config/" | grep -E 'Created|Added' 
node "$HERE/mkuser.js" "$DRILL"              || exit 1

say "Starting a real instance"
( cd "$ROOT" && nohup ./main.js --config "$DRILL/config/" > "$DRILL/stdout.txt" 2>&1 & )
for i in $(seq 1 30); do
    grep -q 'System started!' "$DRILL/stdout.txt" 2>/dev/null && break
    sleep 1
done
grep -qE 'System started!' "$DRILL/stdout.txt" || { tail -20 "$DRILL/stdout.txt"; exit 1; }
grep -E 'listening|System started' "$DRILL/stdout.txt" | sed 's/^/  /'

say "EchoMail arrives for areas that are not configured"
node "$HERE/mkpkt.js" "$DRILL" drill001.pkt
toss
logs 'Automatically created|Refused to automatically|imported with'

say "The rescan request left the building"
find "$DRILL/out" -type f | sed "s|$DRILL/out/|  |"
logs 'Queued AreaFix|Message exported|cannot be routed'

say "A mock uplink answers, in each tosser's dialect"
n=10
for style in husky sbbsecho crashmail rescanned unknown; do
    area="TST_$(echo "$style" | tr 'a-z' 'A-Z' | cut -c1-4)X"
    find "$DRILL/out" -type f -delete 2>/dev/null
    DRILL_AREAS="$area" node "$HERE/mkpkt.js" "$DRILL" "drill0$n.pkt" > /dev/null
    toss 7
    node "$HERE/robot.js" "$DRILL" "$style" drillop | sed 's/^/  /'
    toss 7
    n=$((n + 1))
done
logs 'AreaFix reply for'

say "Restarting with a populated auto-areas.hjson"
stop
( cd "$ROOT" && nohup ./main.js --config "$DRILL/config/" > "$DRILL/stdout2.txt" 2>&1 & )
for i in $(seq 1 30); do
    grep -q 'System started!' "$DRILL/stdout2.txt" 2>/dev/null && break
    sleep 1
done
grep -qE 'System started!' "$DRILL/stdout2.txt" \
    && echo "  clean start with generated areas in place" \
    || { tail -20 "$DRILL/stdout2.txt"; exit 1; }

say "Areas as the board now sees them"
node "$ROOT/oputil.js" mb list-confs --areas --config "$DRILL/config/" 2>/dev/null | sed 's/^/  /'

say "Done -- drill tree left at $DRILL"
