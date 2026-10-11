import type { ReactNode } from "react";
import { AppShell } from "../../components/AppShell";

/** All signed-in app surfaces share the shell (nav rail / feed column / right rail). */
export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
