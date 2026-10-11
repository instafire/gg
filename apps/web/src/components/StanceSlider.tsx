"use client";

import { testIds } from "@gg/ui";

/** The five stance stops (D-029): the slider IS the −2..+2 stance scale. */
export const STANCE_STOPS = [
  { value: -2, label: "Strongly against" },
  { value: -1, label: "Against" },
  { value: 0, label: "Neutral" },
  { value: 1, label: "For" },
  { value: 2, label: "Strongly for" },
] as const;

/**
 * Five-stop stance picker used by stance_slider polls and debate
 * before/after stance votes. Segmented buttons (keyboard-native) rather
 * than a continuous range input: the scale has exactly five values.
 */
export function StanceSlider({
  value,
  onChange,
  disabled = false,
  name = "stance",
}: {
  value: number | null;
  onChange: (value: number) => void;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Your stance"
      data-testid={testIds.stanceSlider}
      className="grid grid-cols-5 gap-1"
    >
      {STANCE_STOPS.map((stop) => {
        const selected = value === stop.value;
        return (
          <button
            key={stop.value}
            type="button"
            role="radio"
            aria-checked={selected}
            name={name}
            disabled={disabled}
            onClick={() => onChange(stop.value)}
            className={`min-h-11 rounded-md border px-1 py-2 text-center text-[0.6875rem] leading-tight font-medium transition-colors sm:text-xs ${
              selected
                ? "border-accent bg-accent-tint text-text"
                : "border-border bg-surface-sunken text-text-muted hover:border-border-strong hover:text-text"
            } disabled:opacity-50`}
          >
            {stop.label}
          </button>
        );
      })}
    </div>
  );
}

/** Horizontal distribution bar for a −2..+2 stance map ("-2".."2" keys). */
export function StanceBar({
  distribution,
  label,
}: {
  distribution: Record<string, number>;
  label: string;
}) {
  const total = Object.values(distribution).reduce((sum, n) => sum + n, 0);
  const segments = [
    { key: "-2", color: "var(--danger)", label: "Strongly against" },
    { key: "-1", color: "color-mix(in srgb, var(--danger) 55%, var(--surface))", label: "Against" },
    { key: "0", color: "var(--border-strong)", label: "Neutral" },
    { key: "1", color: "color-mix(in srgb, var(--success) 55%, var(--surface))", label: "For" },
    { key: "2", color: "var(--success)", label: "Strongly for" },
  ];
  return (
    <div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`${label}: ${total} stance votes`}
        data-testid={testIds.liveVoteBar}
      >
        {total > 0
          ? segments.map((segment) => {
              const count = distribution[segment.key] ?? 0;
              if (count === 0) return null;
              return (
                <span
                  key={segment.key}
                  style={{ width: `${(count / total) * 100}%`, background: segment.color }}
                  title={`${segment.label}: ${count}`}
                />
              );
            })
          : null}
      </div>
      <p className="mt-1 text-xs text-text-muted">
        {total === 0 ? `No stance votes yet — ${label.toLowerCase()}` : `${total} stance votes · ${label}`}
      </p>
    </div>
  );
}
