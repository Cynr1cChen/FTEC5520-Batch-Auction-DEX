import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'ftec5520_lang';

function resolveInitialLang(): Lang {
  if (typeof window === 'undefined') return 'en';
  try {
    const param = new URLSearchParams(window.location.search).get('lang');
    if (param === 'en' || param === 'zh') {
      return param;
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') {
      return stored;
    }
  } catch {
    // ignore storage / query access issues
  }
  return 'en';
}

interface LangContextValue {
  lang: Lang;
  setLang: (next: Lang) => void;
  t: (en: string, zh: string) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(resolveInitialLang);

  const setLang = (next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  };

  useEffect(() => {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // ignore storage errors
    }
  }, [lang]);

  const value = useMemo<LangContextValue>(
    () => ({
      lang,
      setLang,
      t: (en: string, zh: string) => (lang === 'en' ? en : zh),
    }),
    [lang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) {
    return {
      lang: 'en',
      setLang: () => undefined,
      t: (en: string) => en,
    };
  }
  return ctx;
}
