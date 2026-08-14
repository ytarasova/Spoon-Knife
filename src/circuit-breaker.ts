export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;    // failures before opening
  successThreshold?: number;    // successes in half-open before closing
  halfOpenTimeout?: number;     // ms to wait before trying half-open
  onStateChange?: (prev: CircuitState, next: CircuitState) => void;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly halfOpenTimeout: number;
  private readonly onStateChange?: (prev: CircuitState, next: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.successThreshold = options.successThreshold ?? 1;
    this.halfOpenTimeout = options.halfOpenTimeout ?? 5000;
    this.onStateChange = options.onStateChange;
  }

  get currentState(): CircuitState {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.halfOpenTimeout) {
        this.transition("half-open");
      }
    }
    return this.state;
  }

  isAvailable(): boolean {
    return this.currentState !== "open";
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.failureCount = 0;
        this.successCount = 0;
        this.transition("closed");
      }
    } else {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;
    this.successCount = 0;

    if (this.state === "half-open" || this.failureCount >= this.failureThreshold) {
      this.transition("open");
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isAvailable()) {
      throw new CircuitOpenError(`Circuit is open`);
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      if (!(err instanceof CircuitOpenError)) {
        this.recordFailure();
      }
      throw err;
    }
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.onStateChange?.(prev, next);
  }
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}
