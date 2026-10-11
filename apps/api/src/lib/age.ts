/**
 * Age-gate logic (DECISIONS D-011: minimum age 13, 13–17 restricted).
 * Pure functions — unit-tested in test/age.test.ts.
 */

export type AgeBracket = "13_17" | "18_24" | "25_plus" | "unknown";

/** Whole years old on `on` (defaults to today, UTC). DOB is a YYYY-MM-DD date. */
export function ageOn(dateOfBirth: string, on: Date = new Date()): number {
  const [y, m, d] = dateOfBirth.split("-").map(Number) as [number, number, number];
  let age = on.getUTCFullYear() - y;
  const month = on.getUTCMonth() + 1;
  const day = on.getUTCDate();
  if (month < m || (month === m && day < d)) age -= 1;
  return age;
}

export function meetsMinAge(dateOfBirth: string, minAge: number, on?: Date): boolean {
  return ageOn(dateOfBirth, on) >= minAge;
}

/** Ages 13–17 get the restricted defaults (spec §10 / D-011). */
export function isMinorRestricted(dateOfBirth: string, on?: Date): boolean {
  const age = ageOn(dateOfBirth, on);
  return age >= 0 && age < 18;
}

export function ageBracket(dateOfBirth: string | null, on?: Date): AgeBracket {
  if (!dateOfBirth) return "unknown";
  const age = ageOn(dateOfBirth, on);
  if (age < 18) return "13_17";
  if (age < 25) return "18_24";
  return "25_plus";
}

/** Strict YYYY-MM-DD calendar-date validation (rejects 2026-02-30 etc.). */
export function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}
