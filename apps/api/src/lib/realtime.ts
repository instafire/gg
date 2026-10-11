/**
 * Realtime hub (Phase 5A, D-048): an in-process registry of WebSocket
 * connections keyed by user id. Services publish events; the WS route
 * (routes/realtime.ts) registers sockets. Delivery is best-effort — every
 * consumer keeps a polling fallback, so a missed event degrades to
 * latency, never to lost data. Single-instance by design (the laptop
 * runs one API process); a Redis pub/sub fan-out is the scale path if
 * the API ever goes multi-instance.
 */
export interface RealtimeSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "close" | "error", listener: () => void): void;
  ping?: () => void;
}

const WS_OPEN = 1;

const hub = new Map<string, Set<RealtimeSocket>>();

export function registerRealtimeSocket(userId: string, socket: RealtimeSocket): void {
  let set = hub.get(userId);
  if (!set) {
    set = new Set();
    hub.set(userId, set);
  }
  set.add(socket);
  const drop = (): void => {
    set!.delete(socket);
    if (set!.size === 0) hub.delete(userId);
  };
  socket.on("close", drop);
  socket.on("error", drop);
}

/** Number of live sockets for a user (tests + diagnostics). */
export function realtimeSocketCount(userId: string): number {
  return hub.get(userId)?.size ?? 0;
}

export function publishToUser(userId: string, event: Record<string, unknown>): void {
  const set = hub.get(userId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(event);
  for (const socket of set) {
    if (socket.readyState !== WS_OPEN) continue;
    try {
      socket.send(data);
    } catch {
      // A dead socket is dropped by its close/error handler; one failed
      // send must never fail the publisher's request.
    }
  }
}

export function publishToUsers(
  userIds: Iterable<string>,
  event: Record<string, unknown>,
  exceptUserId?: string,
): void {
  for (const userId of userIds) {
    if (exceptUserId && userId === exceptUserId) continue;
    publishToUser(userId, event);
  }
}
