import nodemailer from "nodemailer";
import type { AppConfig } from "../config";

/**
 * Outbound mail adapter (D-035, extended in hardening D-070). Every
 * transactional mail — email verification, password reset — flows through
 * this one seam. Two implementations:
 *
 *  - LogMailer: writes the message to the API log; no mail leaves the
 *    box. While this is the configured mailer, auth responses carry the
 *    D-035 dev-link affordance outside production.
 *  - SmtpMailer: real SMTP via nodemailer, selected with MAILER=smtp +
 *    SMTP_* env. When it is active the dev-link affordance disappears
 *    automatically (the links really are emailed).
 *
 * Tests inject a fake transport (anything with a nodemailer-shaped
 * `sendMail`) instead of a live server.
 */
export interface Mailer {
  readonly kind: "log" | "smtp";
  sendVerificationEmail(email: string, url: string): Promise<void>;
  sendPasswordResetEmail(email: string, url: string): Promise<void>;
}

/** Minimal structural shape of a nodemailer transporter (for test fakes). */
export interface MailTransport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

export class LogMailer implements Mailer {
  readonly kind = "log" as const;
  constructor(private readonly log: (message: string) => void) {}

  async sendVerificationEmail(email: string, url: string): Promise<void> {
    this.log(`[mailer:log] verification email for ${email}: ${url}`);
  }

  async sendPasswordResetEmail(email: string, url: string): Promise<void> {
    this.log(`[mailer:log] password reset email for ${email}: ${url}`);
  }
}

export class SmtpMailer implements Mailer {
  readonly kind = "smtp" as const;
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  private async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text });
  }

  async sendVerificationEmail(email: string, url: string): Promise<void> {
    await this.send(
      email,
      "Verify your GG email",
      `Welcome to GG. Verify your email address to unlock voting and debates:\n\n${url}\n\nThe link expires in 24 hours. If you didn't sign up, ignore this email.`,
    );
  }

  async sendPasswordResetEmail(email: string, url: string): Promise<void> {
    await this.send(
      email,
      "Reset your GG password",
      `A password reset was requested for your GG account.\n\n${url}\n\nThe link expires in 1 hour. If you didn't request it, ignore this email — your password stays unchanged.`,
    );
  }
}

/** Build the nodemailer transport from SMTP_* config. */
export function createSmtpTransport(config: AppConfig): MailTransport {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    ...(config.SMTP_USER
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } }
      : {}),
  }) as MailTransport;
}

/** Build the configured mailer. `log` receives one line per "sent" email. */
export function createMailer(
  config: AppConfig,
  log: (message: string) => void,
  transportOverride?: MailTransport,
): Mailer {
  switch (config.MAILER) {
    case "log":
      return new LogMailer(log);
    case "smtp":
      return new SmtpMailer(
        transportOverride ?? createSmtpTransport(config),
        config.SMTP_FROM,
      );
  }
}

/**
 * Whether auth responses may carry dev links (D-035/D-070): only while
 * no real mailer is configured, and never in production.
 */
export function devLinksEnabled(config: AppConfig): boolean {
  return config.NODE_ENV !== "production" && config.MAILER === "log";
}
