"use client";

import { useEffect } from "react";
import { api } from "../lib/api";
import { notifyBadgeChanged } from "../lib/badge";
import {
  notifyMessagesChanged,
  notifyTyping,
  realtimeWsUrl,
  type RealtimeEvent,
} from "../lib/realtime";
import { useSession } from "../lib/session";

/**
 * Realtime bridge (Phase 5A, D-048): while authenticated, keep one
 * WebSocket open to the API and translate pushes into window events —
 * message.* refreshes the inbox/thread, notification.created and
 * debate.turn refresh the badges, typing feeds the thread indicator.
 * If the socket fails or closes, a 45 s badge poll keeps counts fresh
 * (the graceful polling fallback); reconnects back off to 30 s.
 */
export function RealtimeBridge() {
  const { status } = useSession();

  useEffect(() => {
    if (status !== "authenticated") return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retryMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = setInterval(() => notifyBadgeChanged(), 45_000);

    const connect = () => {
      if (closed) return;
      const token = api.getAccessToken();
      if (!token) {
        retryTimer = setTimeout(connect, 3000);
        return;
      }
      try {
        socket = new WebSocket(realtimeWsUrl(token));
      } catch {
        retryTimer = setTimeout(connect, retryMs);
        return;
      }
      socket.onopen = () => {
        retryMs = 1000;
      };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as RealtimeEvent;
          if (data.type === "typing") {
            if (data.conversation_id && data.handle) {
              notifyTyping(data.conversation_id, data.handle);
            }
            return;
          }
          if (data.type.startsWith("message.")) {
            notifyMessagesChanged(data.conversation_id);
            notifyBadgeChanged();
          } else if (
            data.type === "notification.created" ||
            data.type === "debate.turn"
          ) {
            notifyBadgeChanged();
          }
        } catch {
          // Malformed frames are ignored.
        }
      };
      socket.onclose = () => {
        if (closed) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          // already closed
        }
      };
    };
    connect();

    return () => {
      closed = true;
      clearInterval(poll);
      if (retryTimer) clearTimeout(retryTimer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
    };
  }, [status]);

  return null;
}
