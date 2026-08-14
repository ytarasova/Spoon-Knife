"""
Lease owner process: acquires a lease and holds it by sending periodic
heartbeats.  Can be killed with SIGKILL at any time to simulate a crash.

SIGKILL bypasses all signal handlers, so the lease file is left in the
"held" state with a dead PID — the canonical lease-owner crash scenario.
"""

import argparse
import json
import os
import signal
import sys
import time

import lease_manager


class _StopSignal(Exception):
    """Raised by our SIGTERM handler so the finally block can run cleanly."""


def _install_sigterm_handler() -> None:
    def _handler(signum, frame):
        raise _StopSignal()
    signal.signal(signal.SIGTERM, _handler)


def run(
    lease_dir: str,
    owner: str,
    ttl_secs: float = lease_manager.DEFAULT_TTL_SECS,
    heartbeat_interval: float = 0.1,
    max_heartbeats: int | None = None,
    ready_file: str | None = None,
) -> None:
    """
    Acquire the lease and hold it by renewing the heartbeat on each tick.

    Writes *ready_file* (if given) once the first heartbeat has been sent,
    so tests can synchronise without polling the lease file directly.

    On SIGKILL the process terminates immediately — the lease file is left
    in "held" status with a stale PID, ready for crash detection.

    On SIGTERM the finally block runs, releasing the lease cleanly.
    """
    os.makedirs(lease_dir, exist_ok=True)
    _install_sigterm_handler()

    acquired = lease_manager.acquire(lease_dir, owner=owner, ttl_secs=ttl_secs)
    if not acquired:
        print(f"FAIL: could not acquire lease (held by another owner)", file=sys.stderr)
        sys.exit(1)

    print(f"Lease acquired by {owner!r} (PID {os.getpid()})", flush=True)

    ticks = 0
    try:
        while max_heartbeats is None or ticks < max_heartbeats:
            ok = lease_manager.heartbeat(lease_dir)
            if not ok:
                print("WARN: heartbeat failed — lease may have been taken over", file=sys.stderr)
                break
            ticks += 1

            if ticks == 1 and ready_file:
                with open(ready_file, "w") as f:
                    f.write(str(os.getpid()))

            time.sleep(heartbeat_interval)
    except _StopSignal:
        pass
    finally:
        lease_manager.release(lease_dir)
        print(f"Lease released by {owner!r} after {ticks} heartbeat(s)", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Lease owner process")
    parser.add_argument("--lease-dir", default=".", help="Directory for lease files")
    parser.add_argument("--owner", default="default-owner", help="Name identifying this lease holder")
    parser.add_argument("--ttl", type=float, default=lease_manager.DEFAULT_TTL_SECS, help="Lease TTL in seconds")
    parser.add_argument("--heartbeat-interval", type=float, default=0.1, help="Seconds between heartbeats")
    parser.add_argument("--max-heartbeats", type=int, default=None, help="Stop after N heartbeats (default: run forever)")
    parser.add_argument("--ready-file", default=None, help="Path to write once first heartbeat is sent")
    args = parser.parse_args()

    run(
        lease_dir=args.lease_dir,
        owner=args.owner,
        ttl_secs=args.ttl,
        heartbeat_interval=args.heartbeat_interval,
        max_heartbeats=args.max_heartbeats,
        ready_file=args.ready_file,
    )


if __name__ == "__main__":
    main()
