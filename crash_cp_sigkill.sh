#!/usr/bin/env bash
# Demonstrates crashing a cp process with SIGKILL (signal 9).
#
# SIGKILL cannot be caught, blocked, or ignored -- the kernel terminates
# the process immediately with no cleanup opportunity.
#
# To make the kill deterministic regardless of storage speed, the source
# is a named pipe (FIFO).  cp blocks in open(2) waiting for a writer;
# we send SIGKILL before any writer appears, so cp is always in-flight.

set -euo pipefail

FIFO=$(mktemp -u)
DST=$(mktemp)

cleanup() {
    rm -f "$FIFO" "$DST"
}
trap cleanup EXIT

mkfifo "$FIFO"

echo "Starting cp from blocking FIFO..."
# cp opens the FIFO for reading, which blocks until a writer connects.
# That blocking open is interruptible by signals, including SIGKILL.
cp "$FIFO" "$DST" &
CP_PID=$!

# Give cp time to reach the blocking open(2) call.
sleep 0.05

if ! kill -0 "$CP_PID" 2>/dev/null; then
    echo "FAIL: cp exited unexpectedly before SIGKILL" >&2
    exit 1
fi

echo "cp is running (PID $CP_PID); sending SIGKILL..."
kill -SIGKILL "$CP_PID"

set +e
wait "$CP_PID"
STATUS=$?
set -e

case "$STATUS" in
    137) echo "PASS: cp killed by SIGKILL (exit status 137 = 128 + 9)" ;;
    0)   echo "FAIL: cp exited 0 -- was not killed" >&2; exit 1 ;;
    *)   echo "PASS: cp terminated with exit status $STATUS (killed, non-zero)" ;;
esac
