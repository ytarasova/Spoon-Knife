"""Core dispatcher with fault state tracking."""

import time
from typing import Any, Callable, Dict, Optional


class DispatchFault(Exception):
    """Raised when dispatching to a faulted dispatcher."""

    def __init__(self, message: str, fault_count: int, last_fault_at: float):
        super().__init__(message)
        self.fault_count = fault_count
        self.last_fault_at = last_fault_at


class Dispatcher:
    """Event dispatcher with crash/fault awareness.

    Tracks fault state so post-fault probes can interrogate it after recovery.
    """

    def __init__(self) -> None:
        self._handlers: Dict[str, Callable[[Any], Any]] = {}
        self._faulted: bool = False
        self._fault_count: int = 0
        self._last_fault_at: Optional[float] = None
        self._recovered_at: Optional[float] = None
        self._dispatch_count: int = 0
        self._failed_dispatch_count: int = 0

    @property
    def faulted(self) -> bool:
        return self._faulted

    @property
    def fault_count(self) -> int:
        return self._fault_count

    @property
    def last_fault_at(self) -> Optional[float]:
        return self._last_fault_at

    @property
    def recovered_at(self) -> Optional[float]:
        return self._recovered_at

    @property
    def dispatch_count(self) -> int:
        return self._dispatch_count

    @property
    def failed_dispatch_count(self) -> int:
        return self._failed_dispatch_count

    def register(self, event_type: str, handler: Callable[[Any], Any]) -> None:
        """Register a handler for an event type."""
        self._handlers[event_type] = handler

    def unregister(self, event_type: str) -> None:
        """Remove a handler for an event type."""
        self._handlers.pop(event_type, None)

    def dispatch(self, event_type: str, payload: Any = None) -> Any:
        """Dispatch an event. Raises DispatchFault if dispatcher is faulted."""
        if self._faulted:
            self._failed_dispatch_count += 1
            raise DispatchFault(
                f"Dispatcher is faulted; cannot dispatch '{event_type}'",
                fault_count=self._fault_count,
                last_fault_at=self._last_fault_at,
            )
        if event_type not in self._handlers:
            raise KeyError(f"No handler registered for event type: '{event_type}'")
        self._dispatch_count += 1
        return self._handlers[event_type](payload)

    def inject_fault(self) -> None:
        """Transition dispatcher into faulted state (simulates a crash)."""
        self._faulted = True
        self._fault_count += 1
        self._last_fault_at = time.monotonic()
        self._recovered_at = None

    def recover(self) -> None:
        """Recover dispatcher from faulted state."""
        if self._faulted:
            self._faulted = False
            self._recovered_at = time.monotonic()

    def stats(self) -> Dict[str, Any]:
        return {
            "faulted": self._faulted,
            "fault_count": self._fault_count,
            "last_fault_at": self._last_fault_at,
            "recovered_at": self._recovered_at,
            "dispatch_count": self._dispatch_count,
            "failed_dispatch_count": self._failed_dispatch_count,
            "registered_handlers": list(self._handlers.keys()),
        }
