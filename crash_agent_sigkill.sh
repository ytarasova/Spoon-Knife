#!/usr/bin/env bash
# Demonstrates crashing an agent process with SIGKILL (signal 9).
#
# SIGKILL cannot be caught, blocked, or ignored -- the kernel terminates
# the process immediately with no cleanup opportunity.
#
# An "agent" here is a long-running process that processes tasks in a loop,
# simulating an autonomous agent.  We start it, confirm it's running, then
# send SIGKILL before it can respond or clean up.

set -euo pipefail

# The agent: loops forever, simulating ongoing work.
agent() {
    while true; do
        sleep 1
    done
}

export -f agent

echo "Starting agent process..."
bash -c 'agent' &
AGENT_PID=$!

# Give the agent time to start and reach its first sleep.
sleep 0.05

if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    echo "FAIL: agent exited unexpectedly before SIGKILL" >&2
    exit 1
fi

echo "Agent is running (PID $AGENT_PID); sending SIGKILL..."
kill -SIGKILL "$AGENT_PID"

set +e
wait "$AGENT_PID"
STATUS=$?
set -e

case "$STATUS" in
    137) echo "PASS: agent killed by SIGKILL (exit status 137 = 128 + 9)" ;;
    0)   echo "FAIL: agent exited 0 -- was not killed" >&2; exit 1 ;;
    *)   echo "PASS: agent terminated with exit status $STATUS (killed, non-zero)" ;;
esac
