"use client";

import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import { useEffect, useState, type FormEvent } from "react";
import { FieldError, inputClassName, labelClassName } from "../../../components/AuthCard";
import { ApiErrorState, FeedSkeleton } from "../../../components/States";
import { Toggle } from "../../../components/Toggle";
import { api } from "../../../lib/api";
import { useSession } from "../../../lib/session";

/** /settings — profile fields (PATCH /users/me) + account visibility. */
export default function SettingsProfilePage() {
  const { user, refreshUser } = useSession();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [location, setLocation] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [websiteError, setWebsiteError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled) return;
        setDisplayName(user.profile.displayName);
        setBio(user.profile.bio ?? "");
        setLocation(user.profile.location ?? "");
        setWebsiteUrl(user.profile.websiteUrl ?? "");
        setIsPrivate(settings.isPrivate);
      } catch (cause) {
        if (!cancelled) setLoadError(cause);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setWebsiteError(undefined);
    if (websiteUrl && !/^https?:\/\/.+/.test(websiteUrl)) {
      setWebsiteError("Website must start with http:// or https://");
      return;
    }
    setSaving(true);
    setSaved(false);
    setFormError(null);
    try {
      await api.updateProfile({
        displayName: displayName.trim(),
        bio: bio.trim() ? bio.trim() : null,
        location: location.trim() ? location.trim() : null,
        websiteUrl: websiteUrl.trim() ? websiteUrl.trim() : null,
      });
      await api.updateSettings({ isPrivate });
      await refreshUser().catch(() => undefined);
      setSaved(true);
    } catch (cause) {
      setFormError(
        cause instanceof GGApiError ? cause.detail : "Couldn't save your profile.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <FeedSkeleton count={2} />;
  if (loadError) return <ApiErrorState error={loadError} />;

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5"
      data-testid="settings-profile-form"
    >
      <div>
        <label htmlFor="settings-display-name" className={labelClassName}>
          Display name
        </label>
        <input
          id="settings-display-name"
          type="text"
          value={displayName}
          maxLength={50}
          onChange={(event) => setDisplayName(event.target.value)}
          className={inputClassName}
          data-testid="settings-display-name"
        />
      </div>
      <div>
        <label htmlFor="settings-bio" className={labelClassName}>
          Bio
        </label>
        <textarea
          id="settings-bio"
          value={bio}
          maxLength={500}
          rows={3}
          onChange={(event) => setBio(event.target.value)}
          className="w-full rounded-md border border-border bg-surface-sunken px-3 py-2 text-[1rem] placeholder:text-text-muted"
          data-testid="settings-bio"
        />
      </div>
      <div>
        <label htmlFor="settings-location" className={labelClassName}>
          Location
        </label>
        <input
          id="settings-location"
          type="text"
          value={location}
          maxLength={100}
          onChange={(event) => setLocation(event.target.value)}
          className={inputClassName}
          placeholder="City, country — words only, never coordinates"
          data-testid="settings-location"
        />
      </div>
      <div>
        <label htmlFor="settings-website" className={labelClassName}>
          Website
        </label>
        <input
          id="settings-website"
          type="url"
          value={websiteUrl}
          onChange={(event) => setWebsiteUrl(event.target.value)}
          aria-invalid={Boolean(websiteError)}
          aria-describedby={websiteError ? "settings-website-error" : undefined}
          className={inputClassName}
          placeholder="https://example.com"
          data-testid="settings-website"
        />
        <FieldError id="settings-website-error" message={websiteError} />
      </div>
      <div className="border-t border-border">
        <Toggle
          label="Private account"
          description="Only followers can see your posts. New followers need your approval flow (coming with the follow-requests slice)."
          checked={isPrivate}
          onChange={setIsPrivate}
          testId="settings-is-private"
        />
      </div>
      {formError ? (
        <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving} data-testid="settings-profile-save">
          {saving ? "Saving…" : "Save profile"}
        </Button>
        {saved ? (
          <span role="status" className="text-sm font-medium text-text-soft">
            Saved ✓
          </span>
        ) : null}
      </div>
    </form>
  );
}
