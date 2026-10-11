"use client";

/**
 * Phase 5B i18n — a deliberately small dictionary-based setup (no i18n
 * runtime dep): the AppShell/nav, home feed tabs, and auth screens are
 * externalized; the rest of the app still renders English (recorded in
 * PROGRESS as the honest coverage line). Adding a locale = adding one
 * dictionary object typed against `en`.
 *
 * The active locale persists in localStorage ("gg-locale") and is mirrored
 * to the account via settings.language when changed in Settings. The
 * provider also keeps `<html lang>` correct after hydration (the server
 * render is lang="en").
 *
 * NOTE (pa): the Punjabi translations are machine-assisted and reviewed
 * for the core strings only — a native-speaker pass is still wanted
 * before calling them final.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const en = {
  nav: {
    home: "Home",
    explore: "Explore",
    reels: "Reels",
    notifications: "Notifications",
    messages: "Messages",
    debates: "Debates",
    communities: "Communities",
    bookmarks: "Bookmarks",
    lists: "Lists",
    agents: "Agents",
    developers: "Developers",
    profile: "Profile",
    settings: "Settings",
    analytics: "Analytics",
    search: "Search",
    create: "Create",
  },
  shell: {
    searchPlaceholder: "Search GG",
    primaryNav: "Primary",
  },
  home: {
    title: "Home",
    feedLabel: "Home feed",
    forYou: "For you",
    following: "Following",
  },
  auth: {
    loginTitle: "Log in",
    loginSubmit: "Log in",
    registerTitle: "Create your account",
    registerSubmit: "Create account",
    email: "Email",
    password: "Password",
    handle: "Handle",
    dateOfBirth: "Date of birth",
    needAccount: "New to GG?",
    haveAccount: "Already have an account?",
    createOne: "Create an account",
    forgotPassword: "Forgot your password?",
    orContinueWith: "or continue with",
    totpTitle: "Two-factor authentication",
    totpPrompt: "Enter the 6-digit code from your authenticator app (or a recovery code).",
    totpSubmit: "Verify and log in",
    passkeySubmit: "Log in with a passkey",
  },
  settings: {
    language: "Language",
    languageHelp: "Applies to navigation, home and sign-in screens for now.",
  },
};

export type Dict = typeof en;
export type Locale = "en" | "pa";

// Machine-assisted Punjabi (Gurmukhi) translations of the core strings —
// see the note at the top of this file.
const pa: Dict = {
  nav: {
    home: "ਘਰ",
    explore: "ਖੋਜ",
    reels: "ਰੀਲਾਂ",
    notifications: "ਸੂਚਨਾਵਾਂ",
    messages: "ਸੁਨੇਹੇ",
    debates: "ਬਹਿਸਾਂ",
    communities: "ਭਾਈਚਾਰੇ",
    bookmarks: "ਸੰਭਾਲੇ ਹੋਏ",
    lists: "ਸੂਚੀਆਂ",
    agents: "ਏਜੰਟ",
    developers: "ਡਿਵੈਲਪਰ",
    profile: "ਪ੍ਰੋਫ਼ਾਈਲ",
    settings: "ਸੈਟਿੰਗਾਂ",
    analytics: "ਅੰਕੜੇ",
    search: "ਖੋਜੋ",
    create: "ਬਣਾਓ",
  },
  shell: {
    searchPlaceholder: "GG ਵਿੱਚ ਖੋਜੋ",
    primaryNav: "ਮੁੱਖ",
  },
  home: {
    title: "ਘਰ",
    feedLabel: "ਘਰ ਫੀਡ",
    forYou: "ਤੁਹਾਡੇ ਲਈ",
    following: "ਫਾਲੋ ਕਰ ਰਹੇ",
  },
  auth: {
    loginTitle: "ਲੌਗ ਇਨ ਕਰੋ",
    loginSubmit: "ਲੌਗ ਇਨ ਕਰੋ",
    registerTitle: "ਆਪਣਾ ਖਾਤਾ ਬਣਾਓ",
    registerSubmit: "ਖਾਤਾ ਬਣਾਓ",
    email: "ਈਮੇਲ",
    password: "ਪਾਸਵਰਡ",
    handle: "ਹੈਂਡਲ",
    dateOfBirth: "ਜਨਮ ਤਾਰੀਖ",
    needAccount: "GG 'ਤੇ ਨਵੇਂ ਹੋ?",
    haveAccount: "ਪਹਿਲਾਂ ਹੀ ਖਾਤਾ ਹੈ?",
    createOne: "ਖਾਤਾ ਬਣਾਓ",
    forgotPassword: "ਪਾਸਵਰਡ ਭੁੱਲ ਗਏ?",
    orContinueWith: "ਜਾਂ ਇਸ ਨਾਲ ਜਾਰੀ ਰੱਖੋ",
    totpTitle: "ਦੋ-ਕਾਰਕ ਪ੍ਰਮਾਣਿਕਤਾ",
    totpPrompt: "ਆਪਣੀ ਪ੍ਰਮਾਣਿਕਤਾ ਐਪ ਤੋਂ 6-ਅੰਕਾਂ ਦਾ ਕੋਡ ਦਾਖਲ ਕਰੋ (ਜਾਂ ਰਿਕਵਰੀ ਕੋਡ)।",
    totpSubmit: "ਤਸਦੀਕ ਕਰੋ ਅਤੇ ਲੌਗ ਇਨ ਕਰੋ",
    passkeySubmit: "ਪਾਸਕੀ ਨਾਲ ਲੌਗ ਇਨ ਕਰੋ",
  },
  settings: {
    language: "ਭਾਸ਼ਾ",
    languageHelp: "ਫਿਲਹਾਲ ਨੇਵੀਗੇਸ਼ਨ, ਘਰ ਅਤੇ ਸਾਈਨ-ਇਨ ਸਕ੍ਰੀਨਾਂ 'ਤੇ ਲਾਗੂ ਹੁੰਦਾ ਹੈ।",
  },
};

export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "pa", label: "ਪੰਜਾਬੀ (Punjabi)" },
];

export const dictionaries: Record<Locale, Dict> = { en, pa };

const STORAGE_KEY = "gg-locale";

interface LocaleContextValue {
  locale: Locale;
  t: Dict;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  t: en,
  setLocale: () => undefined,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "pa" || stored === "en") setLocaleState(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, t: dictionaries[locale], setLocale }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
