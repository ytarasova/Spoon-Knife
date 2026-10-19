"""Post-fault dispatch probe: verifies dispatcher health after a fault."""

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .dispatcher import Dispatcher, DispatchFault


@dataclass
class ProbeResult:
    """Outcome of a post-fault probe run."""

    ok: bool
    faulted_before_probe: bool
    recovered: bool
    dispatch_ok: bool
    fault_count: int
    latency_ms: float
    errors: List[str] = field(default_factory=list)
    details: Dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        status = "PASS" if self.ok else "FAIL"
        return (
            f"ProbeResult[{status}] faulted={self.faulted_before_probe} "
            f"recovered={self.recovered} dispatch_ok={self.dispatch_ok} "
            f"fault_count={self.fault_count} latency={self.latency_ms:.2f}ms"
        )


_PROBE_EVENT = "__dispatch_probe__"
_PROBE_PAYLOAD = {"source": "PostFaultProbe", "ts": None}


class PostFaultProbe:
    """Probe that tests dispatcher health in the post-fault window.

    Sequence:
      1. Record pre-probe dispatcher state.
      2. Attempt recovery if dispatcher is still faulted.
      3. Send a synthetic probe event and verify round-trip.
      4. Return a ProbeResult with diagnostics.
    """

    def __init__(self, dispatcher: Dispatcher, auto_recover: bool = True) -> None:
        self._dispatcher = dispatcher
        self._auto_recover = auto_recover

    def run(self) -> ProbeResult:
        t0 = time.monotonic()
        errors: List[str] = []

        faulted_before = self._dispatcher.faulted
        recovered = False

        if faulted_before and self._auto_recover:
            self._dispatcher.recover()
            recovered = not self._dispatcher.faulted
            if not recovered:
                errors.append("Recovery attempted but dispatcher remains faulted")
        elif faulted_before:
            errors.append("Dispatcher is faulted and auto_recover is disabled")

        # Register probe handler if not already present
        probe_registered = _PROBE_EVENT in self._dispatcher.stats()["registered_handlers"]
        if not probe_registered:
            self._dispatcher.register(_PROBE_EVENT, lambda p: {**p, "ack": True})

        dispatch_ok = False
        try:
            payload = {**_PROBE_PAYLOAD, "ts": time.monotonic()}
            result = self._dispatcher.dispatch(_PROBE_EVENT, payload)
            dispatch_ok = isinstance(result, dict) and result.get("ack") is True
            if not dispatch_ok:
                errors.append(f"Probe dispatch returned unexpected result: {result!r}")
        except DispatchFault as exc:
            errors.append(f"Dispatch fault during probe: {exc}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"Unexpected error during probe dispatch: {exc}")
        finally:
            if not probe_registered:
                self._dispatcher.unregister(_PROBE_EVENT)

        latency_ms = (time.monotonic() - t0) * 1000
        ok = dispatch_ok and not errors

        return ProbeResult(
            ok=ok,
            faulted_before_probe=faulted_before,
            recovered=recovered,
            dispatch_ok=dispatch_ok,
            fault_count=self._dispatcher.fault_count,
            latency_ms=latency_ms,
            errors=errors,
            details=self._dispatcher.stats(),
        )
