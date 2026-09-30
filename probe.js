'use strict';

const { Dispatcher, DISPATCH_STATE, FAULT_TYPES } = require('./dispatch');

class PostFaultProbe {
  constructor(dispatcher) {
    if (!(dispatcher instanceof Dispatcher)) {
      throw new TypeError('probe requires a Dispatcher instance');
    }
    this._dispatcher = dispatcher;
    this._probeResults = [];
  }

  get results() {
    return this._probeResults.slice();
  }

  async run() {
    const result = {
      timestamp: Date.now(),
      dispatcherState: this._dispatcher.state,
      faultCount: this._dispatcher.faultHistory.length,
      faultSummary: this._summarizeFaults(),
      healthy: false,
      checks: {},
    };

    result.checks.stateIsRecoverable = this._checkStateRecoverable();
    result.checks.noUnresolvedFaults = this._checkNoUnresolvedFaults();
    result.checks.dispatcherResponsive = await this._checkDispatcherResponsive();

    result.healthy =
      result.checks.stateIsRecoverable &&
      result.checks.noUnresolvedFaults &&
      result.checks.dispatcherResponsive;

    this._probeResults.push(result);
    return result;
  }

  _checkStateRecoverable() {
    const recoverableStates = [
      DISPATCH_STATE.IDLE,
      DISPATCH_STATE.RECOVERING,
      DISPATCH_STATE.RECOVERED,
    ];
    return recoverableStates.includes(this._dispatcher.state);
  }

  _checkNoUnresolvedFaults() {
    const faults = this._dispatcher.faultHistory;
    if (faults.length === 0) return true;
    const crashFaults = faults.filter(f => f.type === FAULT_TYPES.CRASH);
    return crashFaults.length === 0;
  }

  async _checkDispatcherResponsive() {
    const pingType = '__probe_ping__';
    const probeDispatcher = new Dispatcher({ maxRetries: 0 });
    probeDispatcher.register(pingType, async () => ({ pong: true }));
    try {
      await probeDispatcher.dispatch(pingType, {});
      return true;
    } catch (_) {
      return false;
    }
  }

  _summarizeFaults() {
    const faults = this._dispatcher.faultHistory;
    if (faults.length === 0) return null;
    const counts = {};
    for (const f of faults) {
      counts[f.type] = (counts[f.type] || 0) + 1;
    }
    return counts;
  }
}

module.exports = { PostFaultProbe };
