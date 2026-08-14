/**
 * Lease: time-limited ownership of a named resource.
 *
 * When the owner crashes without releasing the lease explicitly, the
 * lease expires after `ttlMs` milliseconds and another caller can
 * acquire it — this is the "crash: lease owner dies" scenario.
 */

class Lease {
  constructor(owner, ttlMs, grantedAt) {
    this.owner = owner;
    this.ttlMs = ttlMs;
    this.grantedAt = grantedAt;
  }

  expiresAt() {
    return this.grantedAt + this.ttlMs;
  }

  isExpired(now) {
    return now >= this.expiresAt();
  }
}

class LeaseManager {
  /**
   * @param {{ now(): number }} [clock] - injectable clock for testing
   */
  constructor(clock = Date) {
    this._leases = new Map();
    this._clock = clock;
  }

  /**
   * Try to acquire a lease on `resource` for `owner`.
   *
   * Returns true if the lease was granted (either no holder exists or
   * the previous holder's lease has expired), false if another owner
   * currently holds a live lease.
   *
   * @param {string} resource
   * @param {string} owner
   * @param {number} ttlMs
   */
  acquire(resource, owner, ttlMs) {
    const now = this._clock.now();
    const existing = this._leases.get(resource);

    if (existing && !existing.isExpired(now)) {
      return false;
    }

    this._leases.set(resource, new Lease(owner, ttlMs, now));
    return true;
  }

  /**
   * Voluntarily release a lease.  Only the current owner may release.
   *
   * @param {string} resource
   * @param {string} owner
   * @returns {boolean} true if released, false if caller is not the owner
   */
  release(resource, owner) {
    const now = this._clock.now();
    const existing = this._leases.get(resource);
    if (!existing || existing.isExpired(now) || existing.owner !== owner) {
      return false;
    }
    this._leases.delete(resource);
    return true;
  }

  /**
   * Return the current owner of the lease, or null if there is none
   * (no lease, or the lease has expired because the owner crashed).
   *
   * @param {string} resource
   * @returns {string|null}
   */
  getOwner(resource) {
    const now = this._clock.now();
    const lease = this._leases.get(resource);
    if (!lease || lease.isExpired(now)) {
      return null;
    }
    return lease.owner;
  }

  /**
   * Renew a currently-held lease, extending its TTL from now.
   *
   * @param {string} resource
   * @param {string} owner
   * @param {number} ttlMs
   * @returns {boolean} true if renewed, false if caller does not hold the lease
   */
  renew(resource, owner, ttlMs) {
    const now = this._clock.now();
    const existing = this._leases.get(resource);
    if (!existing || existing.isExpired(now) || existing.owner !== owner) {
      return false;
    }
    this._leases.set(resource, new Lease(owner, ttlMs, now));
    return true;
  }
}

module.exports = { Lease, LeaseManager };
