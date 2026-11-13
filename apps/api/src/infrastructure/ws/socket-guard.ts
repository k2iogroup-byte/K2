export type SocketGuard = {
  maxPayloadBytes: number;
  maxQueuedBeforeAuth: number;
  maxMessagesPerWindow: number;
  messageWindowMs: number;
  authTimeoutMs: number;
  slowConsumerBytes: number;
};

/** Abuse caps for one connection. They do not coordinate across API replicas. */
export const DEFAULT_SOCKET_GUARD: SocketGuard = {
  maxPayloadBytes: 4_096,
  maxQueuedBeforeAuth: 4,
  maxMessagesPerWindow: 30,
  messageWindowMs: 10_000,
  authTimeoutMs: 5_000,
  slowConsumerBytes: 1_048_576,
};
