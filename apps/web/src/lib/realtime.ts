/**
 * Realtime client helpers (Phase 5A, D-048). The API pushes events over
 * `GET /api/v1/ws?token=…`; the bridge component turns them into the
 * window events the shell and message views already understand.
 */
import { API_BASE_URL } from "./api";

/** Dispatched when a message event arrives (detail: { conversationId }). */
export const MESSAGES_CHANGED_EVENT = "gg:messages-changed";
/** Dispatched when a typing event arrives (detail: { conversationId, handle }). */
export const TYPING_EVENT = "gg:typing";

export function notifyMessagesChanged(conversationId?: string): void {
  window.dispatchEvent(
    new CustomEvent(MESSAGES_CHANGED_EVENT, { detail: { conversationId } }),
  );
}

export function notifyTyping(conversationId: string, handle: string): void {
  window.dispatchEvent(
    new CustomEvent(TYPING_EVENT, { detail: { conversationId, handle } }),
  );
}

export function realtimeWsUrl(token: string): string {
  const base = API_BASE_URL.replace(/^http/, "ws");
  return `${base}/api/v1/ws?token=${encodeURIComponent(token)}`;
}

export interface RealtimeEvent {
  type: string;
  conversation_id?: string;
  handle?: string;
  [key: string]: unknown;
}
