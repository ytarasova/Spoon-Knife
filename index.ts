export { Dispatcher, type DispatcherOptions } from "./src/Dispatcher.js";
export { ReplicaPool, type ReplicaPoolOptions } from "./src/ReplicaPool.js";
export { Replica, type ReplicaOptions } from "./src/Replica.js";
export { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from "./src/CircuitBreaker.js";
export {
  type ReplicaId,
  type ReplicaStatus,
  type ReplicaInfo,
  type ReplicaHandler,
  type DispatchRequest,
  type DispatchResult,
  type DispatchOptions,
  DispatchError,
  AllReplicasFailedError,
} from "./src/types.js";
