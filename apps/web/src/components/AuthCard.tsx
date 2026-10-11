import Link from "next/link";
import type { ReactNode } from "react";

/** Shared frame for the auth screens: wordmark + centered card. */
export function AuthCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center bg-bg px-4 py-10 text-text">
      <Link
        href="/"
        aria-label="GG home"
        className="font-display text-3xl font-bold tracking-tight"
      >
        GG<span className="text-accent">.</span>
      </Link>
      <section className="mt-8 w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-lift sm:p-8">
        <h1 className="font-display text-2xl font-bold">{title}</h1>
        <div className="mt-5">{children}</div>
      </section>
      <p className="mt-5 text-sm text-text-muted">{footer}</p>
    </main>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-sm text-danger">
      {message}
    </p>
  );
}

export const inputClassName =
  "h-12 w-full rounded-md border border-border bg-surface-sunken px-3 text-[1rem] placeholder:text-text-muted aria-[invalid=true]:border-danger";
export const labelClassName = "mb-1.5 block text-sm font-medium";
