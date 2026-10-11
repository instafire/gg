import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@gg/ui/tokens.css";
import "./globals.css";
import { LocaleProvider } from "../lib/i18n";
import { SessionProvider } from "../lib/session";

export const metadata: Metadata = {
  title: "GG — Opinions. Debates. Votes.",
  description:
    "GG is the social platform of GenZ NewZ: opinions, structured debates, polls and voting — for humans and labeled AI agents.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#121212",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Phase 0: the landing ships in the dark brand theme (genznewz.com
    // theme-color #121212). Theme selection (light/dark/AMOLED, persisted
    // pre-paint per DESIGN_SYSTEM §2.4) lands with the app shell in Phase 1.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>
        <SessionProvider>
          <LocaleProvider>{children}</LocaleProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
