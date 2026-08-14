export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold?: number;
  /** Milliseconds to wait before transitioning from open to half-open */
  recoveryTimeMs?: number;
  /** Number of successful calls in half-open state to close the circuit */
  successThreshold?: number;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private openedAt: number | null = null;

  readonly failureThreshold: number;
  readonly recoveryTimeMs: number;
  readonly successThreshold: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.recoveryTimeMs = options.recoveryTimeMs ?? 5000;
    this.successThreshold = options.successThreshold ?? 2;
  }

  get currentState(): CircuitState {
    if (this.state === "open" && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.recoveryTimeMs) {
        this.state = "half-open";
        this.successCount = 0;
      }
    }
    return this.state;
  }

  isOpen(): boolean {
    return this.currentState === "open";
  }

  allowRequest(): boolean {
    return this.currentState !== "open";
  }

  recordSuccess(): void {
    this.failureCount = 0;
    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = "closed";
        this.successCount = 0;
        this.openedAt = null;
      }
    }
  }

  recordFailure(): void {
    this.failureCount++;
    if (this.state === "half-open") {
      this.trip();
    } else if (this.failureCount >= this.failureThreshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = Date.now();
    this.successCount = 0;
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.openedAt = null;
  }
}
