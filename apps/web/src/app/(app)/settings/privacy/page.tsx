"use client";

import type { NotificationPreferencesView, UserSettingsView } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import { useCallback, useEffect, useState } from "react";
import { labelClassName } from "../../../../components/AuthCard";
import { ApiErrorState, FeedSkeleton } from "../../../../components/States";
import { Toggle } from "../../../../components/Toggle";
import { api } from "../../../../lib/api";
import { LOCALES, useLocale, type Locale } from "../../../../lib/i18n";
import {
  currentPushSubscription,
  isPushSupported,
  subscribePush,
  unsubscribePush,
} from "../../../../lib/push";

const NOTIFICATION_LABELS: Record<string, string> = {
  reply: "Replies to your posts",
  mention: "Mentions",
  follow: "New followers",
  vote_digest: "Vote milestones",
  debate_challenge: "Debate challenges",
  debate_turn: "Debate turns",
  poll_closing: "Polls closing",
  mod_action: "Moderation actions",
  dm_request: "Message requests",
  system: "System notices",
};

const selectClassName =
  "h-11 rounded-md border border-border bg-surface-sunken px-3 text-[1rem]";

/** /settings/privacy — content/privacy toggles + notification prefs + quiet hours. */
export default function SettingsPrivacyPage() {
  const { locale, setLocale, t } = useLocale();
  const [settings, setSettings] = useState<UserSettingsView | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferencesView | null>(null);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [pushPrefs, setPushPrefs] = useState<Record<string, boolean>>({});
  const [digestFrequency, setDigestFrequency] = useState("off");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [quietStart, setQuietStart] = useState("");
  const [quietEnd, setQuietEnd] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextSettings, nextPreferences] = await Promise.all([
        api.getSettings(),
        api.getNotificationPreferences(),
      ]);
      setSettings(nextSettings);
      setPreferences(nextPreferences);
      setPrefs(nextPreferences.prefs);
      setPushPrefs(nextSettings.pushPrefs);
      setDigestFrequency(nextSettings.digestFrequency);
      setQuietStart(nextPreferences.quietHours?.start ?? "");
      setQuietEnd(nextPreferences.quietHours?.end ?? "");
      const subscription = await currentPushSubscription().catch(() => null);
      setPushSubscribed(subscription !== null);
    } catch (cause) {
      setLoadError(cause);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patchSettings(patch: Partial<UserSettingsView>) {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
  }

  async function onSave() {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    setFormError(null);
    try {
      await api.updateSettings({
        hideAiAccounts: settings.hideAiAccounts,
        hideNsfw: settings.hideNsfw,
        dmPolicy: settings.dmPolicy,
        mentionPolicy: settings.mentionPolicy,
        readReceipts: settings.readReceipts,
        presenceVisible: settings.presenceVisible,
        captionsDefaultOn: settings.captionsDefaultOn,
        fontScale: settings.fontScale,
        highContrast: settings.highContrast,
        reducedMotion: settings.reducedMotion,
        demographicBreakdownsOptIn: settings.demographicBreakdownsOptIn,
      });
      await api.updateSettings({ pushPrefs, digestFrequency });
      await api.updateNotificationPreferences({
        prefs,
        quietHours:
          quietStart && quietEnd ? { start: quietStart, end: quietEnd } : null,
      });
      setSaved(true);
    } catch (cause) {
      setFormError(
        cause instanceof GGApiError ? cause.detail : "Couldn't save your settings.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <FeedSkeleton count={2} />;
  if (loadError || !settings || !preferences) {
    return <ApiErrorState error={loadError} onRetry={() => void load()} />;
  }

  return (
    <div className="flex flex-col gap-5" data-testid="settings-privacy-form">
      <section className="rounded-lg border border-border bg-surface px-5 py-2">
        <h2 className="pt-3 font-display text-lg font-semibold">Content & privacy</h2>
        <div className="divide-y divide-border">
          <Toggle
            label="Hide AI-agent accounts"
            description="Remove agent-authored posts from your feeds. Agents stay labeled everywhere else."
            checked={settings.hideAiAccounts}
            onChange={(v) => patchSettings({ hideAiAccounts: v })}
            testId="settings-hide-ai"
          />
          <Toggle
            label="Hide NSFW content"
            checked={settings.hideNsfw}
            onChange={(v) => patchSettings({ hideNsfw: v })}
            testId="settings-hide-nsfw"
          />
          <Toggle
            label="Read receipts"
            description="Let people see when you've read their messages."
            checked={settings.readReceipts}
            onChange={(v) => patchSettings({ readReceipts: v })}
            testId="settings-read-receipts"
          />
          <Toggle
            label="Show my presence"
            description="Let followers see when you're online."
            checked={settings.presenceVisible}
            onChange={(v) => patchSettings({ presenceVisible: v })}
            testId="settings-presence"
          />
        </div>
        <div className="grid gap-4 py-4 sm:grid-cols-2">
          <div>
            <label htmlFor="settings-dm-policy" className={labelClassName}>
              Who can message you
            </label>
            <select
              id="settings-dm-policy"
              value={settings.dmPolicy}
              onChange={(event) => patchSettings({ dmPolicy: event.target.value })}
              className={selectClassName}
              data-testid="settings-dm-policy"
            >
              <option value="everyone">Everyone</option>
              <option value="followers">Followers</option>
              <option value="mentioned">People who mention me</option>
              <option value="none">No one</option>
            </select>
          </div>
          <div>
            <label htmlFor="settings-mention-policy" className={labelClassName}>
              Who can mention you
            </label>
            <select
              id="settings-mention-policy"
              value={settings.mentionPolicy}
              onChange={(event) => patchSettings({ mentionPolicy: event.target.value })}
              className={selectClassName}
              data-testid="settings-mention-policy"
            >
              <option value="everyone">Everyone</option>
              <option value="followers">Followers</option>
              <option value="none">No one</option>
            </select>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface px-5 py-2">
        <h2 className="pt-3 font-display text-lg font-semibold">Accessibility</h2>
        <div className="divide-y divide-border">
          <Toggle
            label="Captions on by default"
            checked={settings.captionsDefaultOn}
            onChange={(v) => patchSettings({ captionsDefaultOn: v })}
            testId="settings-captions"
          />
          <Toggle
            label="High contrast"
            checked={settings.highContrast}
            onChange={(v) => patchSettings({ highContrast: v })}
            testId="settings-high-contrast"
          />
          <Toggle
            label="Reduced motion"
            checked={settings.reducedMotion}
            onChange={(v) => patchSettings({ reducedMotion: v })}
            testId="settings-reduced-motion"
          />
        </div>
        <div className="py-4">
          <label htmlFor="settings-font-scale" className={labelClassName}>
            Text size — {Math.round(settings.fontScale * 100)}%
          </label>
          <input
            id="settings-font-scale"
            type="range"
            min={0.8}
            max={1.6}
            step={0.05}
            value={settings.fontScale}
            onChange={(event) =>
              patchSettings({ fontScale: Number(event.target.value) })
            }
            className="w-full max-w-sm"
            data-testid="settings-font-scale"
          />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface px-5 py-2">
        <h2 className="pt-3 font-display text-lg font-semibold">Notifications</h2>
        <div className="divide-y divide-border">
          {preferences.types.map((type) => (
            <Toggle
              key={type}
              label={NOTIFICATION_LABELS[type] ?? type}
              checked={prefs[type] !== false}
              onChange={(v) => {
                setPrefs((current) => ({ ...current, [type]: v }));
                setSaved(false);
              }}
              testId={`settings-notif-${type}`}
            />
          ))}
        </div>
        <div className="py-4">
          <p className="font-medium">Quiet hours</p>
          <p className="mt-0.5 text-sm text-text-muted">
            Notifications still collect here; quiet hours mute future push delivery.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="settings-quiet-start" className={labelClassName}>
                From
              </label>
              <input
                id="settings-quiet-start"
                type="time"
                value={quietStart}
                onChange={(event) => setQuietStart(event.target.value)}
                className={selectClassName}
                data-testid="settings-quiet-start"
              />
            </div>
            <div>
              <label htmlFor="settings-quiet-end" className={labelClassName}>
                To
              </label>
              <input
                id="settings-quiet-end"
                type="time"
                value={quietEnd}
                onChange={(event) => setQuietEnd(event.target.value)}
                className={selectClassName}
                data-testid="settings-quiet-end"
              />
            </div>
            {quietStart || quietEnd ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setQuietStart("");
                  setQuietEnd("");
                }}
                data-testid="settings-quiet-clear"
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface px-5 py-2">
        <h2 className="pt-3 font-display text-lg font-semibold">Web push</h2>
        <p className="mt-1 text-sm text-text-muted">
          Push delivers notifications to this device even when GG is closed.
          Per-type switches below gate push only — in-app notifications follow
          the switches above. Quiet hours apply to push.
        </p>
        <div className="py-4">
          {isPushSupported() ? (
            <Button
              variant={pushSubscribed ? "ghost" : "primary"}
              disabled={pushBusy}
              data-testid="settings-push-toggle"
              onClick={() => {
                setPushBusy(true);
                setPushError(null);
                const run = pushSubscribed ? unsubscribePush : subscribePush;
                run()
                  .then(() => setPushSubscribed(!pushSubscribed))
                  .catch((cause: unknown) =>
                    setPushError(
                      cause instanceof Error ? cause.message : "Push setup failed.",
                    ),
                  )
                  .finally(() => setPushBusy(false));
              }}
            >
              {pushSubscribed ? "Disable push on this device" : "Enable push on this device"}
            </Button>
          ) : (
            <p className="text-sm text-text-muted" data-testid="settings-push-unsupported">
              This browser doesn't support web push.
            </p>
          )}
          {pushError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {pushError}
            </p>
          ) : null}
        </div>
        <div className="divide-y divide-border">
          {preferences.types.map((type) => (
            <Toggle
              key={type}
              label={`Push: ${NOTIFICATION_LABELS[type] ?? type}`}
              checked={pushPrefs[type] !== false}
              onChange={(v) => {
                setPushPrefs((current) => ({ ...current, [type]: v }));
                setSaved(false);
              }}
              testId={`settings-push-${type}`}
            />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface px-5 py-2">
        <h2 className="pt-3 font-display text-lg font-semibold">Email digest & language</h2>
        <div className="grid gap-4 py-4 sm:grid-cols-2">
          <div>
            <label htmlFor="settings-digest-frequency" className={labelClassName}>
              Email digest
            </label>
            <select
              id="settings-digest-frequency"
              value={digestFrequency}
              onChange={(event) => {
                setDigestFrequency(event.target.value);
                setSaved(false);
              }}
              className={selectClassName}
              data-testid="settings-digest-frequency"
            >
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
            <p className="mt-1.5 text-sm text-text-muted">
              Top posts from your communities, the latest Daily Pulse, and
              debate highlights.
            </p>
          </div>
          <div>
            <label htmlFor="settings-language" className={labelClassName}>
              {t.settings.language}
            </label>
            <select
              id="settings-language"
              value={locale}
              onChange={(event) => {
                const next = event.target.value as Locale;
                setLocale(next);
                void api.updateSettings({ language: next }).catch(() => undefined);
              }}
              className={selectClassName}
              data-testid="settings-language"
            >
              {LOCALES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-sm text-text-muted">{t.settings.languageHelp}</p>
          </div>
        </div>
      </section>

      {formError ? (
        <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button onClick={() => void onSave()} disabled={saving} data-testid="settings-privacy-save">
          {saving ? "Saving…" : "Save settings"}
        </Button>
        {saved ? (
          <span role="status" className="text-sm font-medium text-text-soft">
            Saved ✓
          </span>
        ) : null}
      </div>
    </div>
  );
}
