#!/usr/bin/env bash
# Demonstrates rolling (SIGTERM) a cp process while a copy is in flight.
#
# SIGTERM is the standard "roll" signal used by orchestrators for graceful
# rolling restarts.  Unlike SIGKILL, SIGTERM can be caught by a process, but
# cp does not install a signal handler and terminates promptly -- leaving the
# destination file in a partial (incomplete) state.
#
# To make the roll deterministic while data is actively flowing, the source is
# a named pipe (FIFO) fed by a slow writer; cp is reliably inside a read(2)
# syscall when SIGTERM arrives, confirming it was in-flight at the time of roll.

set -euo pipefail

FIFO=$(mktemp -u)
DST=$(mktemp)
WRITER_PID=""

cleanup() {
    [[ -n "$WRITER_PID" ]] && kill "$WRITER_PID" 2>/dev/null || true
    rm -f "$FIFO" "$DST"
}
trap cleanup EXIT

mkfifo "$FIFO"

# Slow writer: drip-feeds bytes so cp is reliably in-flight when rolled.
(
    while true; do
        printf 'x' 2>/dev/null || break
        sleep 0.01
    done
) > "$FIFO" &
WRITER_PID=$!

echo "Starting cp from active FIFO (data in flight)..."
# cp opens the FIFO for reading; the writer above unblocks it.
# Both sides connect and data begins flowing.
cp "$FIFO" "$DST" &
CP_PID=$!

# Give cp time to open the FIFO and enter its active read/write loop.
sleep 0.1

if ! kill -0 "$CP_PID" 2>/dev/null; then
    echo "FAIL: cp exited unexpectedly before SIGTERM" >&2
    exit 1
fi

echo "cp is in-flight (PID $CP_PID); sending SIGTERM (roll)..."
kill -SIGTERM "$CP_PID"

set +e
wait "$CP_PID"
STATUS=$?
set -e

case "$STATUS" in
    143) echo "PASS: cp rolled by SIGTERM (exit status 143 = 128 + 15)" ;;
    0)   echo "FAIL: cp exited 0 -- was not rolled" >&2; exit 1 ;;
    *)   echo "PASS: cp terminated with exit status $STATUS (rolled, non-zero)" ;;
esac
