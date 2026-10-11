"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { RequireAuth } from "../../../lib/session";

const SECTIONS = [
  { href: "/settings", label: "Profile" },
  { href: "/settings/privacy", label: "Privacy & notifications" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/account", label: "Account" },
] as const;

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <RequireAuth>
      <div className="flex flex-col gap-5">
        <h1 className="font-display text-2xl font-bold">Settings</h1>
        <nav aria-label="Settings sections" className="flex gap-1 border-b border-border">
          {SECTIONS.map((section) => {
            const active =
              section.href === "/settings"
                ? pathname === "/settings"
                : pathname.startsWith(section.href);
            return (
              <Link
                key={section.href}
                href={section.href}
                aria-current={active ? "page" : undefined}
                data-testid={`settings-nav-${section.label.split(" ")[0]!.toLowerCase()}`}
                className={`flex min-h-12 items-center border-b-2 px-4 font-medium transition-colors ${
                  active
                    ? "border-accent text-text"
                    : "border-transparent text-text-muted hover:text-text"
                }`}
              >
                {section.label}
              </Link>
            );
          })}
        </nav>
        {children}
      </div>
    </RequireAuth>
  );
}
