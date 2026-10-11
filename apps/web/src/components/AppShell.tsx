"use client";

import { testIds } from "@gg/ui";
import {
  BarChart3,
  Bell,
  Bookmark,
  Bot,
  Clapperboard,
  Code,
  Compass,
  Home,
  List,
  MessageCircle,
  Plus,
  Search,
  Settings,
  Swords,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { NOTIFICATIONS_CHANGED_EVENT } from "../lib/badge";
import { useLocale, type Dict } from "../lib/i18n";
import { useSession } from "../lib/session";
import { Avatar } from "./Avatar";
import { PulseRailCard } from "./PulseRailCard";
import { RealtimeBridge } from "./RealtimeBridge";
import { TrendingRailCard } from "./TrendingRailCard";
import { VerifyEmailBanner } from "./VerifyEmailBanner";

interface NavItem {
  href: string;
  /** Dictionary key (lib/i18n) — labels render in the active locale. */
  labelKey: keyof Dict["nav"];
  testId: string;
  icon: typeof Home;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/home", labelKey: "home", testId: "nav-home", icon: Home },
  { href: "/explore", labelKey: "explore", testId: "nav-explore", icon: Compass },
  { href: "/reels", labelKey: "reels", testId: "nav-reels", icon: Clapperboard },
  { href: "/notifications", labelKey: "notifications", testId: "nav-notifications", icon: Bell },
  { href: "/messages", labelKey: "messages", testId: "nav-messages", icon: MessageCircle },
  { href: "/debates", labelKey: "debates", testId: "nav-debates", icon: Swords },
  { href: "/communities", labelKey: "communities", testId: "nav-communities", icon: Users },
  { href: "/bookmarks", labelKey: "bookmarks", testId: "nav-bookmarks", icon: Bookmark },
  { href: "/lists", labelKey: "lists", testId: "nav-lists", icon: List },
  { href: "/agents", labelKey: "agents", testId: "nav-agents", icon: Bot },
  { href: "/developers", labelKey: "developers", testId: "nav-developers", icon: Code },
  { href: "/profile", labelKey: "profile", testId: "nav-profile", icon: User },
  { href: "/settings", labelKey: "settings", testId: "nav-settings", icon: Settings },
];

/** Platform admins additionally see the Phase 5B analytics dashboard. */
const ADMIN_NAV_ITEM: NavItem = {
  href: "/admin/analytics",
  labelKey: "analytics",
  testId: "nav-analytics",
  icon: BarChart3,
};

function isActive(pathname: string, href: string): boolean {
  if (href === "/home") return pathname === "/home";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Unread counts for the nav badges (notifications + DMs, D-053); refreshes
 * on navigation and whenever a page signals a change (e.g. mark-all-read). */
function useUnreadCounts(): { notifications: number; dms: number } {
  const { status } = useSession();
  const pathname = usePathname();
  const [counts, setCounts] = useState({ notifications: 0, dms: 0 });

  useEffect(() => {
    if (status !== "authenticated") {
      setCounts({ notifications: 0, dms: 0 });
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .getUnreadCounts()
        .then((next) => {
          if (!cancelled) setCounts(next);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, load);
    };
  }, [status, pathname]);

  return counts;
}

export function UnreadBadge({
  count,
  testId = "nav-notifications-badge",
  label = "unread notifications",
}: {
  count: number;
  testId?: string;
  label?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      data-testid={testId}
      aria-label={`${count} ${label}`}
      className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[0.625rem] font-bold text-accent-ink"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function NavLinks({
  iconOnly = false,
  unreadCount,
  dmUnreadCount,
}: {
  iconOnly?: boolean;
  unreadCount: number;
  dmUnreadCount: number;
}) {
  const pathname = usePathname();
  const { t } = useLocale();
  const { user } = useSession();
  const items =
    user?.platformRole === "admin" ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => {
        const label = t.nav[item.labelKey];
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        const badgeCount =
          item.href === "/notifications"
            ? unreadCount
            : item.href === "/messages"
              ? dmUnreadCount
              : 0;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              data-testid={item.testId}
              aria-current={active ? "page" : undefined}
              aria-label={iconOnly ? label : undefined}
              className={`flex min-h-12 items-center gap-3 rounded-lg px-3 text-[1rem] transition-colors ${
                active
                  ? "bg-accent-tint font-semibold text-text"
                  : "text-text-soft hover:bg-surface-sunken"
              }`}
            >
              <span className="relative">
                <Icon
                  size={24}
                  aria-hidden="true"
                  strokeWidth={active ? 2.4 : 1.8}
                  className={active ? "text-accent" : undefined}
                />
                {badgeCount > 0 ? (
                  <UnreadBadge
                    count={badgeCount}
                    testId={
                      item.href === "/messages"
                        ? "nav-messages-badge"
                        : "nav-notifications-badge"
                    }
                    label={
                      item.href === "/messages"
                        ? "unread conversations"
                        : "unread notifications"
                    }
                  />
                ) : null}
              </span>
              {iconOnly ? null : <span>{label}</span>}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SearchBox() {
  const router = useRouter();
  const { t } = useLocale();
  const [query, setQuery] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
  }

  return (
    <form role="search" onSubmit={onSubmit} className="w-full max-w-sm">
      <label htmlFor="site-search" className="sr-only">
        {t.nav.search} GG
      </label>
      <div className="relative">
        <Search
          size={18}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-muted"
        />
        <input
          id="site-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.shell.searchPlaceholder}
          data-testid="site-search-input"
          className="h-11 w-full rounded-full border border-border bg-surface-sunken pr-3 pl-10 text-sm placeholder:text-text-muted"
        />
      </div>
    </form>
  );
}

function SessionChip() {
  const { status, user, logout } = useSession();
  if (status === "loading") {
    return <div className="h-10 w-24 rounded-full bg-[var(--skeleton)]" aria-hidden="true" />;
  }
  if (status !== "authenticated" || !user) {
    return (
      <Link
        href="/login"
        data-testid="header-login"
        className="flex min-h-11 items-center rounded-full bg-accent px-4 font-semibold text-accent-ink"
      >
        Log in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Link
        href={`/u/${user.handle}`}
        className="flex items-center gap-2 rounded-full py-1 pr-2 pl-1 hover:bg-surface-sunken"
        aria-label={`Your profile, @${user.handle}`}
      >
        <Avatar name={user.profile.displayName} avatarUrl={user.profile.avatarUrl} size={32} />
        <span className="hidden max-w-32 truncate text-sm font-medium xl:block">
          @{user.handle}
        </span>
      </Link>
      <button
        type="button"
        onClick={() => void logout()}
        data-testid="header-logout"
        className="min-h-11 rounded-full px-3 text-sm text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
      >
        Log out
      </button>
    </div>
  );
}

/**
 * App shell (DESIGN_SYSTEM §6): 3 columns at lg (260px nav / 640px feed /
 * 320px rail), icon rail at sm–md, bottom tab bar on xs.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const counts = useUnreadCounts();
  const unreadCount = counts.notifications;
  return (
    <div className="min-h-screen bg-bg text-text">
      <RealtimeBridge />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-accent-ink"
      >
        Skip to feed
      </a>
      <a
        href="#primary-nav"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-36 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-accent-ink"
      >
        Skip to navigation
      </a>

      <header
        data-testid={testIds.siteHeader}
        className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur"
      >
        <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center gap-4 px-4 sm:px-6">
          <Link
            href="/home"
            aria-label="GG home"
            className="font-display text-2xl font-bold tracking-tight"
          >
            GG<span className="text-accent">.</span>
          </Link>
          <div className="hidden flex-1 justify-center sm:flex">
            <SearchBox />
          </div>
          <div className="ml-auto sm:ml-0">
            <SessionChip />
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-6 px-4 pt-6 pb-24 sm:grid-cols-[72px_minmax(0,640px)] sm:px-6 sm:pb-10 lg:grid-cols-[260px_minmax(0,640px)_320px] lg:justify-center">
        <nav id="primary-nav" aria-label="Primary" className="hidden sm:block">
          <div className="sticky top-24">
            <div className="lg:hidden">
              <NavLinks iconOnly unreadCount={unreadCount} dmUnreadCount={counts.dms} />
            </div>
            <div className="hidden lg:block">
              <NavLinks unreadCount={unreadCount} dmUnreadCount={counts.dms} />
            </div>
          </div>
        </nav>

        <main id="main-content" className="min-w-0">
          <VerifyEmailBanner />
          {children}
        </main>

        <aside aria-label="Discover" className="hidden lg:block">
          <div className="sticky top-24 flex flex-col gap-4">
            <PulseRailCard />
            <TrendingRailCard />
            <footer className="px-1 text-xs text-text-muted">
              <p>
                <a href="https://genznewz.com" className="hover:underline">
                  GenZ NewZ
                </a>{" "}
                · GG — opinions, debates, votes.
              </p>
            </footer>
          </div>
        </aside>
      </div>

      <BottomTabBar unreadCount={unreadCount} />
    </div>
  );
}

const TAB_ITEMS: {
  href: string;
  labelKey: keyof Dict["nav"];
  testId: string;
  icon: typeof Home;
  isCreate?: boolean;
}[] = [
  { href: "/home", labelKey: "home", testId: "tab-home", icon: Home },
  { href: "/explore", labelKey: "explore", testId: "tab-explore", icon: Compass },
  { href: "/home", labelKey: "create", testId: "tab-create", icon: Plus, isCreate: true },
  { href: "/debates", labelKey: "debates", testId: "tab-debates", icon: Swords },
  { href: "/notifications", labelKey: "notifications", testId: "tab-notifications", icon: Bell },
];

/** Bottom tab bar (xs only, §6.3): labels always visible, Create is the accent action. */
function BottomTabBar({ unreadCount }: { unreadCount: number }) {
  const pathname = usePathname() ?? "";
  const { t } = useLocale();
  return (
    <nav
      aria-label="Primary mobile"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      <ul className="grid grid-cols-5">
        {TAB_ITEMS.map((item) => {
          const active = !item.isCreate && isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.testId}>
              <Link
                href={item.href}
                data-testid={item.testId}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-16 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium ${
                  active ? "text-text" : "text-text-muted"
                }`}
              >
                {item.isCreate ? (
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink">
                    <Icon size={24} aria-hidden="true" />
                  </span>
                ) : (
                  <span className="relative">
                    <Icon size={26} aria-hidden="true" strokeWidth={active ? 2.4 : 1.8} />
                    {item.href === "/notifications" ? (
                      <UnreadBadge count={unreadCount} />
                    ) : null}
                  </span>
                )}
                <span>{t.nav[item.labelKey]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
