"use client";

import { api } from "./api";

/**
 * Phase 5B web-push client: registers /sw.js, subscribes with the server
 * VAPID key, and mirrors the subscription to the API (which the worker's
 * push sweep delivers to). Browser support is feature-detected; callers
 * render an honest unsupported state.
 */

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js");
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/sw.js");
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/**
 * Full subscribe flow: permission → SW registration → pushManager
 * subscription → API record. Throws with a readable message on denial.
 */
export async function subscribePush(): Promise<void> {
  if (!isPushSupported()) throw new Error("Push isn't supported in this browser.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const { publicKey } = await api.getVapidPublicKey();
  if (!publicKey) {
    throw new Error("Push isn't configured on this server yet.");
  }
  const reg = await registration();
  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser returned an incomplete subscription.");
  }
  await api.createPushSubscription({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
}

/** Unsubscribe in the browser and delete the server record. */
export async function unsubscribePush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  const mine = await api.listPushSubscriptions().catch(() => []);
  const record = mine.find((row) => row.endpoint === subscription.endpoint);
  await subscription.unsubscribe();
  if (record) await api.deletePushSubscription(record.id);
}
