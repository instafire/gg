/** AppShell listens for this event to refresh the nav unread badge immediately. */
export const NOTIFICATIONS_CHANGED_EVENT = "gg:notifications-changed";

export function notifyBadgeChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}
