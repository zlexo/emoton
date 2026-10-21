#!/bin/bash
# End-to-end checks of the BUILT Emoton.app against the stub server
# (scripts/shell-stub-server.mjs). Needs port 8891 free. Build first:
#   npx tauri build --bundles app
# Run:
#   scripts/shell-e2e.sh            (all scenarios, about 1.5 minutes)
#   scripts/shell-e2e.sh spawn      (one scenario: spawn reuse keep exited mismatch restore crash lost freed timeout)
#
# What it cannot do: click. Quits come two ways:
#   NSRunningApplication -terminate (by pid)  the real terminate: path, as Dock Quit
#   EMOTON_TEST_QUIT_EVERY_MS  env hook: the app runs its quit flow every N ms, the
#                              same call the ⌘Q item and the close button make
# and EMOTON_QUIT_ANSWER (stop | keep) answers the jobs dialog without showing it.
# The ⌘Q menu item, the dialog itself, menu events and Finder drops stay
# human checks.
#
# Evidence lands in the stub's record ($REC) and the shell's lines in
# ~/Library/Logs/Emoton/server.log. Every app and stub it starts is stopped.

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP=${APP:-$ROOT/src-tauri/target/release/bundle/macos/Emoton.app}
BIN="$APP/Contents/MacOS/emoton"
STUB="$ROOT/scripts/shell-stub-server.mjs"
REC=${TMPDIR:-/tmp}/emoton-shell-e2e.jsonl
LOG="$HOME/Library/Logs/Emoton/server.log"
STATE="$HOME/Library/Application Support/me.zlex.emoton/window.json"
PASS=0
FAIL=0
MARK=0

ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

newlog() { tail -n +"$((MARK + 1))" "$LOG" 2>/dev/null; }
logged() { newlog | grep -q -- "$1"; }
has() { grep -q -- "$1" "$REC" 2>/dev/null; }
count() { grep -c -- "$1" "$REC" 2>/dev/null || true; }
wait_rec() { local i; for ((i = 0; i < $2 * 4; i++)); do has "$1" && return 0; sleep 0.25; done; return 1; }
wait_log() { local i; for ((i = 0; i < $2 * 4; i++)); do logged "$1" && return 0; sleep 0.25; done; return 1; }
app_pid() { pgrep -f "^$BIN" | head -1; }
wait_gone() { local i; for ((i = 0; i < $2 * 4; i++)); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.25; done; return 1; }
listening() { lsof -nP -iTCP:8891 -sTCP:LISTEN >/dev/null 2>&1; }
# The terminate: path (same as Dock Quit and logout), sent to the BUILT app's
# pid only, never by bundle id: an installed Emoton must not be touched.
# In the background: -terminate waits for the app's answer.
apple_quit() {
  local pid
  pid=$(app_pid)
  [ -n "$pid" ] || return 0
  (osascript -l JavaScript -e "ObjC.import('AppKit'); \$.NSRunningApplication.runningApplicationWithProcessIdentifier($pid).terminate" >/dev/null 2>&1 &)
}
stub_pid() { grep '"type":"listening"' "$REC" | tail -1 | sed -E 's/.*"pid":([0-9]+).*/\1/'; }

begin() {
  echo "== $1"
  rm -f "$REC"
  mkdir -p "$(dirname "$LOG")"
  touch "$LOG"
  MARK=$(wc -l <"$LOG" | tr -d ' ')
  if listening; then
    echo "port 8891 is in use; stop whatever listens there first" >&2
    exit 2
  fi
}

# open -n: a real LaunchServices launch, so the app starts with a GUI
# environment (bare PATH), exactly like a Finder launch.
launch() { open -n "$APP" --env STUB_RECORD="$REC" "$@"; }

start_stub() { STUB_RECORD="$REC" "$@" node "$STUB" >/dev/null 2>&1 & }

cleanup() {
  local p
  p=$(app_pid)
  [ -n "$p" ] && kill -9 "$p" 2>/dev/null
  pkill -f "shell-stub-server.mjs" 2>/dev/null
  return 0
}
trap cleanup EXIT

scenario_spawn() {
  begin "spawn: nothing listens, the app spawns the server, loads it, quits with running jobs (answer: stop)"
  rm -f "$STATE"
  launch --env EMOTON_SERVER_CMD="node $STUB" --env STUB_JOBS=running --env STUB_DELAY_MS=1500 \
    --env STUB_NAVTEST=1 --env EMOTON_TEST_NO_EXTERNAL_OPEN=1 \
    --env EMOTON_TEST_QUIT_EVERY_MS=9000 --env EMOTON_QUIT_ANSWER=stop
  wait_rec '"type":"report","page"' 20
  wait_rec '"navGuard"' 10
  local app stub
  app=$(app_pid)
  stub=$(stub_pid)
  check "the app spawned the server (log)" "logged 'spawned server pid'"
  check "the stub's parent is the app (ps: stub $stub, app $app)" "[ \"\$(ps -o ppid= -p $stub | tr -d ' ')\" = '$app' ]"
  check "the page loaded inside the app with window.__TAURI__, from 127.0.0.1" "has '\"page\":{\"href\":\"http://127.0.0.1:8891/\",\"tauri\":true,'"
  check "the spawned server got EMOTON_PARENT_PIPE=1 and a stdin pipe (lsof)" "lsof -p $stub -a -d 0 2>/dev/null | grep -q PIPE"
  check "the plugin JS APIs are there (dialog, opener, notification)" "has '\"plugins\":{\"dialog\":true,\"opener\":true,\"notification\":true}'"
  check "dialog open is granted to the remote origin" "has '\"cmd\":\"plugin:dialog|open\",\"result\":\"granted\"'"
  check "dialog save is granted" "has '\"cmd\":\"plugin:dialog|save\",\"result\":\"granted\"'"
  check "opener reveal_item_in_dir is granted" "has '\"cmd\":\"plugin:opener|reveal_item_in_dir\",\"result\":\"granted\"'"
  check "opener open_path is granted" "has '\"cmd\":\"plugin:opener|open_path\",\"result\":\"granted\"'"
  check "notification is granted" "has '\"cmd\":\"plugin:notification|is_permission_granted\",\"result\":\"ok\"'"
  check "window start_dragging is granted" "has '\"cmd\":\"plugin:window|start_dragging\",\"result\":\"granted\"'"
  check "open_path refuses a .app by scope" "has '\"cmd\":\"open_path(.app)\",\"result\":\"denied\",\"error\":\"Not allowed to open path'"
  check "open_path lets a bundle source pdf through the scope" "has '\"cmd\":\"open_path(source pdf)\",\"result\":\"\(ok\|granted\)\"'"
  check "control: dialog message is denied" "has '\"cmd\":\"plugin:dialog|message\",\"result\":\"denied\"'"
  check "control: app version (was in core:default) is denied" "has '\"cmd\":\"plugin:app|version\",\"result\":\"denied\"'"
  check "control: window close is denied" "has '\"cmd\":\"plugin:window|close\",\"result\":\"denied\"'"
  check "control: opener open_url is denied" "has '\"cmd\":\"plugin:opener|open_url\",\"result\":\"denied\"'"
  check "control: the splash-only retry command is denied" "has '\"cmd\":\"retry\",\"result\":\"denied\"'"
  check "navigation to another site was cancelled, the page stayed" "has '\"navGuard\":\"http://127.0.0.1:8891/\"'"
  check "that link went to the browser instead (log)" "logged 'navigation to https://example.com/emoton-nav-test opens in the browser instead'"
  check "an unknown scheme was blocked (log)" "logged 'navigation to emoton-e2e://blocked blocked'"
  check "nothing but the two http(s) URLs was handed to the browser" "[ \"\$(newlog | grep -c 'would open in the browser')\" = 2 ]"
  check "window.open went to the browser instead (log)" "logged 'new window for https://example.com/emoton-new-window-test opens in the browser instead'"
  check "event listen for emoton://menu works" "has '\"menuListen\":\"ok\"'"
  check "webview drag-drop listener registers" "has '\"dragDropListen\":\"ok\"'"
  wait_gone "$app" 20
  check "the app quit" "! kill -0 $app 2>/dev/null"
  check "the quit came through the shell's own path (log)" "logged 'quit flow started (Quit item'"
  check "quit asked about 2 unfinished jobs (log)" "logged 'quit requested with 2 unfinished job(s)'"
  check "cancel: job-running" "has '\"type\":\"cancel\",\"id\":\"job-running\"'"
  check "cancel: job-queued" "has '\"type\":\"cancel\",\"id\":\"job-queued\"'"
  check "no cancel for the finished job" "! has '\"type\":\"cancel\",\"id\":\"job-done\"'"
  check "the spawned server got SIGTERM" "has '\"signal\":\"SIGTERM\"'"
  check "the shell saw it stop on SIGTERM (log)" "logged 'stopped (SIGTERM)'"
  check "the stub process is gone" "! kill -0 $stub 2>/dev/null"
  check "window geometry was saved" "[ -s \"$STATE\" ] && grep -q '\"width\"' \"$STATE\""
}

scenario_reuse() {
  begin "reuse: a healthy server already runs, the app reuses it and leaves it running on quit"
  start_stub env STUB_JOBS=running
  wait_rec '"type":"listening"' 10
  local stub app
  stub=$(stub_pid)
  launch --env EMOTON_SERVER_CMD="node $STUB --must-not-run" --env EMOTON_QUIT_ANSWER=stop
  wait_rec '"type":"report","page"' 20
  app=$(app_pid)
  apple_quit
  check "the app reused the server (log)" "logged 'reusing the healthy server'"
  check "no second server was spawned" "! logged 'spawned server pid' && [ \"\$(count '\"type\":\"listening\"')\" = 1 ]"
  check "the page loaded inside the app" "has '\"tauri\":true'"
  wait_gone "$app" 20
  check "the app quit" "! kill -0 $app 2>/dev/null"
  check "the quit came through terminate: (log)" "logged 'quit flow started (terminate:'"
  check "cancel: job-running" "has '\"type\":\"cancel\",\"id\":\"job-running\"'"
  check "cancel: job-queued" "has '\"type\":\"cancel\",\"id\":\"job-queued\"'"
  check "the reused server got NO SIGTERM" "! has '\"signal\":\"SIGTERM\"'"
  check "the reused server still runs" "kill -0 $stub 2>/dev/null && curl -fs 127.0.0.1:8891/api/health >/dev/null"
  check "the shell left it running (log)" "logged 'leaving the server running'"
  kill "$stub" 2>/dev/null
  wait_gone "$stub" 5
}

scenario_keep() {
  begin "keep: running jobs, the user keeps Emoton open; later no jobs, quit goes through without asking"
  start_stub env STUB_JOBS=running
  wait_rec '"type":"listening"' 10
  local stub app
  stub=$(stub_pid)
  launch --env EMOTON_QUIT_ANSWER=keep
  wait_rec '"type":"report","page"' 20
  app=$(app_pid)
  apple_quit
  wait_log 'quit cancelled, keeping Emoton open' 10
  check "terminate: was answered 'keep' and the app stayed (log)" "logged 'quit cancelled, keeping Emoton open'"
  check "the app still runs" "kill -0 $app 2>/dev/null"
  check "no job was cancelled" "! has '\"type\":\"cancel\"'"
  curl -fs -X POST "127.0.0.1:8891/__stub/jobs?mode=none" >/dev/null
  apple_quit
  wait_gone "$app" 15
  check "with no jobs the next quit went through" "! kill -0 $app 2>/dev/null"
  check "still no job was cancelled" "! has '\"type\":\"cancel\"'"
  kill "$stub" 2>/dev/null
  wait_gone "$stub" 5
}

scenario_exited() {
  begin "exited: the spawned server dies during startup, the splash shows the error"
  launch --env EMOTON_SERVER_CMD="node $ROOT/scripts/shell-no-such-server.mjs" --env EMOTON_TEST_QUIT_EVERY_MS=6000
  wait_log 'The server stopped while starting' 15
  local app
  app=$(app_pid)
  check "error logged with the exit status" "logged 'The server stopped while starting (exit status: 1)'"
  check "node's own error is in the log" "logged 'Cannot find module'"
  wait_gone "$app" 15
  check "the app still quits from the splash" "! kill -0 $app 2>/dev/null"
}

scenario_mismatch() {
  begin "mismatch: a server with protocol 2 listens, the splash shows the error, the server is left alone"
  start_stub env STUB_PROTOCOL=2
  wait_rec '"type":"listening"' 10
  local stub app
  stub=$(stub_pid)
  launch --env EMOTON_TEST_QUIT_EVERY_MS=6000
  wait_log 'speaks protocol 2' 15
  app=$(app_pid)
  check "mismatch logged" "logged 'speaks protocol 2, this app speaks protocol 1'"
  check "the UI was not loaded" "! has '\"type\":\"report\"'"
  wait_gone "$app" 15
  check "the app quit" "! kill -0 $app 2>/dev/null"
  check "the other server still runs" "kill -0 $stub 2>/dev/null"
  kill "$stub" 2>/dev/null
  wait_gone "$stub" 5
}

scenario_timeout() {
  begin "timeout: the spawned server never answers, error after 30 s, quit stops it"
  launch --env EMOTON_SERVER_CMD="sleep 120" --env EMOTON_TEST_QUIT_EVERY_MS=36000
  wait_log 'spawned server pid' 15
  local app sleeper
  app=$(app_pid)
  sleeper=$(newlog | grep 'spawned server pid' | tail -1 | sed -E 's/.*pid ([0-9]+).*/\1/')
  wait_log 'within 30 seconds' 40
  check "timeout logged" "logged 'did not answer on port 8891 within 30 seconds'"
  wait_gone "$app" 15
  check "the app quit" "! kill -0 $app 2>/dev/null"
  check "the spawned (sleeping) server was stopped" "! kill -0 $sleeper 2>/dev/null && logged 'stopped (SIGTERM)'"
}

# Launch on the splash (no server), wait, quit through terminate:.
launch_and_quit() {
  check "no other Emoton instance runs" "[ -z \"\$(pgrep -f \"^$BIN\")\" ]"
  launch --env EMOTON_SERVER_CMD="node $ROOT/scripts/shell-no-such-server.mjs"
  wait_log 'The server stopped while starting' 15
  local app
  app=$(app_pid)
  sleep 1
  MARK=$(wc -l <"$LOG" | tr -d ' ')
  apple_quit
  wait_gone "$app" 15
  check "it quit (pid $app)" "[ -n '$app' ] && ! kill -0 $app 2>/dev/null"
}

# Values come from the app's own first save (displays and scale factors
# differ between runs), then get nudged; the next launch must bring back
# exactly the nudged geometry.
scenario_restore() {
  begin "restore: a saved size and position come back on the next launch"
  rm -f "$STATE"
  launch_and_quit
  check "the app saved its window state" "[ -s \"$STATE\" ]"
  local want got
  want=$(python3 - "$STATE" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
m = d
m["x"] += 40; m["y"] += 30; m["width"] -= 40; m["height"] -= 30
json.dump(d, open(p, "w"))
print(*(round(m[k]) for k in ("x", "y", "width", "height")))
PY
)
  launch_and_quit
  got=$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(*(round(m[k]) for k in ("x", "y", "width", "height")))' "$STATE")
  check "nudged geometry came back (want $want, got $got)" "[ '$want' = '$got' ]"
}

scenario_crash() {
  begin "crash: the app is force-killed; its server sees stdin close and exits"
  launch --env EMOTON_SERVER_CMD="node $STUB" --env STUB_JOBS=running
  wait_rec '"type":"report","page"' 20
  local app stub
  app=$(app_pid)
  stub=$(stub_pid)
  check "the server runs, spawned by the app" "logged 'spawned server pid $stub'"
  kill -9 "$app"
  wait_rec '"parent-pipe-eof"' 10
  check "the server saw EOF on its stdin" "has '\"type\":\"parent-pipe-eof\"'"
  wait_gone "$stub" 5
  check "the server exited" "! kill -0 $stub 2>/dev/null"
  check "port 8891 is free" "! listening"
}

scenario_lost() {
  begin "lost: the server dies under a loaded UI; the splash comes back, Try again starts a new one"
  launch --env EMOTON_SERVER_CMD="node $STUB" --env EMOTON_TEST_AUTO_RETRY_MS=1500 --env EMOTON_TEST_QUIT_EVERY_MS=40000
  wait_rec '"type":"report","page"' 20
  local app first
  app=$(app_pid)
  first=$(stub_pid)
  kill -9 "$first"
  wait_log 'server lost, showing the splash' 15
  check "the loss was noticed (log)" "logged 'The server stopped (signal: 9'"
  check "the splash came back (log)" "logged 'server lost, showing the splash'"
  wait_log 'retrying startup' 10
  wait_rec '"type":"listening"' 1
  local i
  for ((i = 0; i < 60; i++)); do [ "$(count '"type":"report","page"')" -ge 2 ] && break; sleep 0.25; done
  check "Try again spawned a new server" "[ \"\$(count '\"type\":\"listening\"')\" = 2 ] && [ \"\$(stub_pid)\" != '$first' ]"
  check "and the UI loaded again" "[ \"\$(count '\"type\":\"report\",\"page\"')\" -ge 2 ]"
  apple_quit
  wait_gone "$app" 20
  check "the app quit" "! kill -0 $app 2>/dev/null"
  check "the new server was stopped" "! listening"
}

scenario_freed() {
  begin "freed: port 8891 is held by something unhealthy that goes away; the app starts its own at once"
  start_stub env STUB_NOT_READY_MS=3000
  wait_rec '"type":"listening"' 10
  local app t0 t1
  t0=$(date +%s)
  launch --env EMOTON_SERVER_CMD="node $STUB" --env EMOTON_TEST_QUIT_EVERY_MS=20000
  wait_rec '"type":"report","page"' 25
  t1=$(date +%s)
  app=$(app_pid)
  check "the app waited on the busy port first (log)" "logged 'port 8891 is taken but not healthy yet'"
  check "then spawned its own when the port was freed (log)" "logged 'port 8891 was freed; starting our own server'"
  check "the UI loaded well before the 30 s timeout ($((t1 - t0)) s)" "[ $((t1 - t0)) -lt 20 ]"
  apple_quit
  wait_gone "$app" 20
  check "the app quit" "! kill -0 $app 2>/dev/null"
}

[ -x "$BIN" ] || { echo "no built app at $APP" >&2; exit 2; }
if [ $# -eq 0 ]; then
  set -- spawn reuse keep exited mismatch restore crash lost freed timeout
fi
for s in "$@"; do "scenario_$s"; done
echo "== $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
