import nodemailer from "nodemailer";

/**
 * Worker mailer adapter (Phase 5B, SMTP added in hardening D-070) —
 * mirrors the API's Mailer seam (apps/api/src/lib/mailer.ts). MAILER=log
 * keeps the honest staging behavior (digest "sends" are written to the
 * worker log and recorded in digest_logs; no mail leaves the box).
 * MAILER=smtp + SMTP_* env sends real mail via nodemailer, using the
 * same env names as the API. Tests inject a fake transport.
 */
export interface WorkerMailer {
  readonly kind: "log" | "smtp";
  sendDigestEmail(to: string, subject: string, html: string): Promise<void>;
}

/** Minimal structural shape of a nodemailer transporter (for test fakes). */
export interface MailTransport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<unknown>;
}

export class LogMailer implements WorkerMailer {
  readonly kind = "log" as const;
  async sendDigestEmail(to: string, subject: string, html: string): Promise<void> {
    console.log(
      `[gg-worker] [mailer:log] digest to=${to} subject="${subject}" html_bytes=${html.length} (LogMailer — no email leaves the box until SMTP lands)`,
    );
  }
}

export class SmtpMailer implements WorkerMailer {
  readonly kind = "smtp" as const;
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  async sendDigestEmail(to: string, subject: string, html: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, html });
  }
}

export function createWorkerMailer(
  env: NodeJS.ProcessEnv,
  transportOverride?: MailTransport,
): WorkerMailer {
  const kind = env.MAILER ?? "log";
  if (kind === "smtp") {
    if (!env.SMTP_HOST) {
      console.warn(
        "[gg-worker] MAILER=smtp but SMTP_HOST is unset; falling back to LogMailer",
      );
      return new LogMailer();
    }
    const transport =
      transportOverride ??
      (nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number.parseInt(env.SMTP_PORT ?? "587", 10),
        secure: env.SMTP_SECURE === "true",
        ...(env.SMTP_USER
          ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
          : {}),
      }) as MailTransport);
    return new SmtpMailer(transport, env.SMTP_FROM ?? "GG <no-reply@genznewz.com>");
  }
  if (kind !== "log") {
    console.warn(`[gg-worker] unknown MAILER=${kind}; falling back to LogMailer`);
  }
  return new LogMailer();
}
