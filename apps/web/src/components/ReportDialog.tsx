"use client";

import type { ReportReason, ReportTargetType } from "@gg/sdk";
import { GGApiError } from "@gg/sdk";
import { Button } from "@gg/ui";
import { Flag, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

export const REPORT_REASONS: { id: ReportReason; label: string; hint: string }[] = [
  { id: "spam", label: "Spam", hint: "Scams, ads, or repeated junk" },
  { id: "harassment", label: "Harassment", hint: "Bullying or targeted abuse" },
  { id: "hate", label: "Hate speech", hint: "Slurs or hate symbols" },
  { id: "violence", label: "Violence", hint: "Threats or graphic violence" },
  { id: "sexual", label: "Sexual content", hint: "Unwanted or explicit sexual content" },
  { id: "self_harm", label: "Self-harm", hint: "Suicide or self-injury content" },
  { id: "misinformation", label: "Misinformation", hint: "False claims presented as fact" },
  { id: "copyright", label: "Copyright", hint: "Someone else's work, posted as their own" },
  { id: "impersonation", label: "Impersonation", hint: "Pretending to be someone else" },
  { id: "other", label: "Something else", hint: "Doesn't fit the categories above" },
];

/**
 * Report flow dialog (DESIGN_SYSTEM ReportDialog). A real <dialog> opened
 * with showModal(): native focus trap, Escape closes, focus returns to the
 * invoking control on close.
 */
export function ReportDialog({
  targetType,
  targetId,
  targetLabel,
  open,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: string;
  /** Human-readable name of the thing being reported, e.g. "this post". */
  targetLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setReason(null);
      setDetails("");
      setError(null);
      setFiled(false);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open ]);

  async function submit() {
    if (!reason || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createReport({
        targetType,
        targetId,
        reason,
        details: details.trim() ? details.trim() : undefined,
      });
      setFiled(true);
    } catch (cause) {
      setError(
        cause instanceof GGApiError ? cause.detail : "Couldn't file that report. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      data-testid="report-dialog"
      aria-labelledby="report-dialog-title"
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(92vw,30rem)] rounded-lg border border-border bg-surface p-0 text-text shadow-modal backdrop:bg-black/60"
    >
      <div className="flex items-start justify-between gap-4 p-5 pb-0">
        <h2 id="report-dialog-title" className="flex items-center gap-2 font-display text-lg font-semibold">
          <Flag size={18} aria-hidden="true" />
          Report {targetLabel}
        </h2>
        <button
          type="button"
          aria-label="Close report dialog"
          data-testid="report-close"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      {filed ? (
        <div className="p-5" data-testid="report-success">
          <p role="status" className="font-medium">
            Report filed — thank you.
          </p>
          <p className="mt-1 text-sm text-text-muted">
            Moderators will review {targetLabel}. Thanks for helping keep GG civil.
          </p>
          <div className="mt-4 flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset>
            <legend className="text-sm font-medium">Why are you reporting this?</legend>
            <div className="mt-3 flex flex-col gap-1">
              {REPORT_REASONS.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-surface-sunken"
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={option.id}
                    data-testid={`report-reason-${option.id}`}
                    checked={reason === option.id}
                    onChange={() => setReason(option.id)}
                    className="mt-1 accent-[#ffbf47]"
                  />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs text-text-muted">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-4 block text-sm font-medium" htmlFor="report-details">
            Anything else moderators should know? <span className="text-text-muted">(optional)</span>
          </label>
          <textarea
            id="report-details"
            data-testid="report-details"
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            maxLength={1000}
            rows={3}
            className="mt-2 w-full rounded-md border border-border bg-surface-sunken px-3 py-2 text-[1rem] placeholder:text-text-muted"
            placeholder="Context, links, prior incidents…"
          />
          {error ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="report-submit"
              disabled={!reason || submitting}
            >
              {submitting ? "Filing…" : "File report"}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
