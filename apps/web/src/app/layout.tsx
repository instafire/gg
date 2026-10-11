import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "@gg/ui/tokens.css";
import "./globals.css";
import { LocaleProvider } from "../lib/i18n";
import { SessionProvider } from "../lib/session";

// Brand typefaces (DESIGN_SYSTEM §3), SELF-HOSTED from ./fonts and mapped
// onto the design-token variables in globals.css. Two lessons baked in:
// (1) the tokens named these families for months without anything loading
// them, so the whole product silently fell back to system-ui and looked
// generic; (2) next/font/google fetches at build time and the staging
// host cannot reach Google Fonts — local files build deterministically
// everywhere. Inter and Space Grotesk are variable fonts (single file,
// weight range); IBM Plex Mono ships as two statics.
const fontDisplay = localFont({
  src: "./fonts/space-grotesk-var.woff2",
  weight: "500 700",
  variable: "--font-display-loaded",
  display: "swap",
});
const fontSans = localFont({
  src: "./fonts/inter-var.woff2",
  weight: "400 700",
  variable: "--font-sans-loaded",
  display: "swap",
});
const fontMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-400.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-500.woff2", weight: "500" },
  ],
  variable: "--font-mono-loaded",
  display: "swap",
});

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
    // Default paint is the dark brand theme (genznewz.com theme-color
    // #121212); the app shell applies the user's persisted theme choice.
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${fontDisplay.variable} ${fontSans.variable} ${fontMono.variable}`}
    >
      <body>
        <SessionProvider>
          <LocaleProvider>{children}</LocaleProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
