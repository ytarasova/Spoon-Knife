/**
 * AutoGate evaluates a set of named checks against a context and
 * returns a structured PASS/FAIL result.
 *
 * Each check is an object with:
 *   - name: string
 *   - run(context): Promise<boolean> — resolves to true (pass) or false/throws (fail)
 */
export class AutoGate {
  constructor(name) {
    this.name = name;
    this.checks = [];
  }

  addCheck(check) {
    this.checks.push(check);
    return this;
  }

  async evaluate(context = {}) {
    if (this.checks.length === 0) {
      return {
        gateName: this.name,
        status: 'PASS',
        results: [],
        failed: [],
        passed: [],
      };
    }

    const results = await Promise.all(
      this.checks.map(async (check) => {
        try {
          const ok = await check.run(context);
          return { name: check.name, passed: Boolean(ok), error: null };
        } catch (err) {
          return { name: check.name, passed: false, error: err.message };
        }
      })
    );

    const failed = results.filter((r) => !r.passed);
    const passed = results.filter((r) => r.passed);

    return {
      gateName: this.name,
      status: failed.length === 0 ? 'PASS' : 'FAIL',
      results,
      failed,
      passed,
    };
  }
}

/**
 * Convenience factory for creating a single named check.
 */
export function createCheck(name, runFn) {
  return { name, run: runFn };
}
