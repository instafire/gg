"use client";

import { GGApiError, type TwoFactorStatus } from "@gg/sdk";
import { Button } from "@gg/ui";
import { startRegistration } from "@simplewebauthn/browser";
import QRCode from "qrcode";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { inputClassName, labelClassName } from "../../../../components/AuthCard";
import { ApiErrorState, FeedSkeleton } from "../../../../components/States";
import { api } from "../../../../lib/api";

/**
 * /settings/security (hardening, D-067/D-068) — TOTP two-factor
 * enrollment/disable with recovery codes, and passkey management.
 */
export default function SettingsSecurityPage() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // TOTP enrollment state.
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Disable state.
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");

  const reload = useCallback(async () => {
    try {
      setStatus(await api.twoFactorStatus());
    } catch (cause) {
      setLoadError(cause);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!otpauthUri) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(otpauthUri, { width: 200, margin: 1 }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [otpauthUri]);

  function fail(cause: unknown, fallback: string) {
    setFormError(cause instanceof GGApiError ? cause.detail : fallback);
  }

  async function onBeginTotp() {
    setBusy(true);
    setFormError(null);
    try {
      const { otpauthUri: uri } = await api.beginTotp();
      setOtpauthUri(uri);
    } catch (cause) {
      fail(cause, "Couldn't start two-factor setup.");
    } finally {
      setBusy(false);
    }
  }

  async function onEnableTotp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const result = await api.verifyTotp({ code: enrollCode.trim() });
      setRecoveryCodes(result.recoveryCodes);
      setOtpauthUri(null);
      setEnrollCode("");
      await reload();
    } catch (cause) {
      fail(cause, "That code didn't match. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onDisableTotp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const disableFields: Record<string, string> = { code: disableCode.trim() };
      disableFields["password"] = disablePassword;
      await api.disableTotp(
        disableFields as { password: string; code: string },
      );
      setDisablePassword("");
      setDisableCode("");
      setNotice("Two-factor authentication is off.");
      await reload();
    } catch (cause) {
      fail(cause, "Couldn't turn off two-factor authentication.");
    } finally {
      setBusy(false);
    }
  }

  async function onAddPasskey() {
    setBusy(true);
    setFormError(null);
    try {
      const options = await api.passkeyRegisterOptions();
      const credential = await startRegistration({
        optionsJSON: options as unknown as Parameters<
          typeof startRegistration
        >[0]["optionsJSON"],
      });
      await api.passkeyRegisterVerify(
        credential as unknown as Record<string, unknown>,
        "Passkey",
      );
      setNotice("Passkey added.");
      await reload();
    } catch (cause) {
      fail(cause, "Passkey registration was cancelled or failed.");
    } finally {
      setBusy(false);
    }
  }

  async function onDeletePasskey(id: string) {
    setBusy(true);
    setFormError(null);
    try {
      await api.deletePasskey(id);
      setNotice("Passkey removed.");
      await reload();
    } catch (cause) {
      fail(cause, "Couldn't remove that passkey.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <ApiErrorState error={loadError} />;
  if (!status) return <FeedSkeleton count={2} />;

  const manualSecret = otpauthUri
    ? new URL(otpauthUri).searchParams.get("secret")
    : null;

  return (
    <div className="flex flex-col gap-5" data-testid="settings-security">
      {notice ? (
        <p role="status" className="rounded-md bg-surface-sunken px-3 py-2 text-sm font-medium text-text-soft">
          {notice}
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-danger">
          {formError}
        </p>
      ) : null}

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <div>
          <h2 className="font-display text-lg font-bold">Two-factor authentication</h2>
          <p className="text-sm text-text-soft">
            {status.totpEnabled
              ? "On — logging in asks for a code from your authenticator app."
              : "Off — add a TOTP authenticator app code to every login. Enabling it also raises your trust tier to T2."}
          </p>
        </div>

        {!status.totpEnabled && !otpauthUri ? (
          <div>
            <Button type="button" disabled={busy} onClick={() => void onBeginTotp()} data-testid="totp-begin">
              Set up two-factor authentication
            </Button>
          </div>
        ) : null}

        {!status.totpEnabled && otpauthUri ? (
          <form onSubmit={onEnableTotp} className="flex flex-col gap-4" data-testid="totp-enroll-form">
            <p className="text-sm text-text-soft">
              Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
            </p>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="TOTP enrollment QR code" width={200} height={200} data-testid="totp-qr" />
            ) : null}
            {manualSecret ? (
              <p className="text-sm">
                Or enter this secret manually:{" "}
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[0.8125rem]" data-testid="totp-secret">
                  {manualSecret}
                </code>
              </p>
            ) : null}
            <div>
              <label htmlFor="totp-enroll-code" className={labelClassName}>
                Code from your app
              </label>
              <input
                id="totp-enroll-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={enrollCode}
                onChange={(event) => setEnrollCode(event.target.value)}
                className={inputClassName}
                data-testid="totp-enroll-code"
              />
            </div>
            <div>
              <Button type="submit" disabled={busy || enrollCode.trim().length < 6} data-testid="totp-enable">
                Turn on two-factor authentication
              </Button>
            </div>
          </form>
        ) : null}

        {recoveryCodes ? (
          <div className="rounded-md border border-border bg-surface-sunken px-4 py-3" data-testid="totp-recovery-codes">
            <p className="text-sm font-medium">
              Save these recovery codes somewhere safe — each works once, and they are shown only now.
            </p>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
              {recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {status.totpEnabled ? (
          <form onSubmit={onDisableTotp} className="flex flex-col gap-4" data-testid="totp-disable-form">
            <div>
              <label htmlFor="totp-disable-password" className={labelClassName}>
                Password
              </label>
              <input
                id="totp-disable-password"
                type="password"
                autoComplete="current-password"
                value={disablePassword}
                onChange={(event) => setDisablePassword(event.target.value)}
                className={inputClassName}
                data-testid="totp-disable-password"
              />
            </div>
            <div>
              <label htmlFor="totp-disable-code" className={labelClassName}>
                Authenticator or recovery code
              </label>
              <input
                id="totp-disable-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={disableCode}
                onChange={(event) => setDisableCode(event.target.value)}
                className={inputClassName}
                data-testid="totp-disable-code"
              />
            </div>
            <div>
              <Button type="submit" variant="destructive" disabled={busy} data-testid="totp-disable">
                Turn off two-factor authentication
              </Button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <div>
          <h2 className="font-display text-lg font-bold">Passkeys</h2>
          <p className="text-sm text-text-soft">
            Sign in with your device (fingerprint, face, or security key) instead of a password.
          </p>
        </div>
        {status.passkeys.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border" data-testid="passkey-list">
            {status.passkeys.map((passkey) => (
              <li key={passkey.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{passkey.label ?? "Passkey"}</p>
                  <p className="text-sm text-text-muted">
                    Added {new Date(passkey.createdAt).toLocaleDateString()}
                    {passkey.lastUsedAt
                      ? ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
                      : " · never used"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void onDeletePasskey(passkey.id)}
                  data-testid={`passkey-delete-${passkey.id}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No passkeys yet.</p>
        )}
        <div>
          <Button type="button" disabled={busy} onClick={() => void onAddPasskey()} data-testid="passkey-add">
            Add a passkey
          </Button>
        </div>
      </section>
    </div>
  );
}
