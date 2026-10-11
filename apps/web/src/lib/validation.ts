import { MIN_AGE } from "@gg/shared";

/**
 * Client-side auth validation mirroring the API contract
 * (docs/API_SPEC.yaml RegisterRequest/LoginRequest) and the shared
 * constants in @gg/shared. The server re-validates everything — this is
 * for fast, plain-language feedback (DESIGN_SYSTEM §1 voice).
 */

export const HANDLE_PATTERN = /^[a-z0-9_]{3,24}$/;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const DISPLAY_NAME_MAX_LENGTH = 50;

export interface RegisterFormValues {
  handle: string;
  displayName: string;
  email: string;
  password: string;
  dateOfBirth: string;
}

export type RegisterFormErrors = Partial<
  Record<"handle" | "displayName" | "email" | "password" | "dateOfBirth", string>
>;

/** Whole years old on `now` for an ISO date (YYYY-MM-DD); null if invalid. */
export function ageFromDateOfBirth(dateOfBirth: string, now = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return null;
  const [, y, m, d] = match;
  const birth = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(birth.getTime())) return null;
  let age = now.getFullYear() - birth.getFullYear();
  const monthDelta = now.getMonth() - birth.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age;
}

export function validateEmail(email: string): string | null {
  if (!email) return "Enter your email.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That email doesn't look right.";
  return null;
}

export function validateRegister(values: RegisterFormValues): RegisterFormErrors {
  const errors: RegisterFormErrors = {};
  if (!HANDLE_PATTERN.test(values.handle)) {
    errors.handle = "3–24 characters: lowercase letters, numbers and underscores.";
  }
  if (values.displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    errors.displayName = `Keep it under ${DISPLAY_NAME_MAX_LENGTH} characters.`;
  }
  const emailError = validateEmail(values.email);
  if (emailError) errors.email = emailError;
  if (values.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  } else if (values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = `Keep it under ${PASSWORD_MAX_LENGTH} characters.`;
  }
  if (!values.dateOfBirth) {
    errors.dateOfBirth = "Enter your date of birth.";
  } else {
    const age = ageFromDateOfBirth(values.dateOfBirth);
    if (age === null) {
      errors.dateOfBirth = "That date doesn't look right.";
    } else if (age < MIN_AGE) {
      errors.dateOfBirth = `You must be at least ${MIN_AGE} to use GG.`;
    }
  }
  return errors;
}

export function validateLogin(values: { email: string; password: string }): {
  email?: string;
  password?: string;
} {
  const errors: { email?: string; password?: string } = {};
  const emailError = validateEmail(values.email);
  if (emailError) errors.email = emailError;
  if (!values.password) errors.password = "Enter your password.";
  return errors;
}
