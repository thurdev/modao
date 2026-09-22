import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { DEFAULT_LANGUAGE, isLanguage, translate, type Language } from '@shared/i18n'
import { useApp } from '../state/store'

/**
 * Translation for the renderer.
 *
 * The language lives in settings, which the store already loads at startup, so
 * `t` is derived from it rather than being a second source of truth. Changing
 * the language in Settings re-renders every screen with no reload.
 */
export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string

const I18nContext = createContext<{ language: Language; t: TranslateFn }>({
  language: DEFAULT_LANGUAGE,
  t: (key, vars) => translate(DEFAULT_LANGUAGE, key, vars)
})

export function I18nProvider(props: { children: ReactNode }): JSX.Element {
  const settings = useApp((s) => s.settings)
  const language = isLanguage(settings?.language) ? settings.language : DEFAULT_LANGUAGE
  const value = useMemo(
    () => ({ language, t: (key: string, vars?: Record<string, string | number>) => translate(language, key, vars) }),
    [language]
  )
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

export function useT(): TranslateFn {
  return useContext(I18nContext).t
}

export function useLanguage(): Language {
  return useContext(I18nContext).language
}
