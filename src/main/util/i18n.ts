import { DEFAULT_LANGUAGE, isLanguage, translate, type Language } from '@shared/i18n'

/**
 * Translation in the main process.
 *
 * The language is pushed in at startup and whenever the setting changes, rather
 * than read from the database on every string: this module is imported by code
 * as low as the filesystem error translator, and that code must stay free of
 * anything that needs Electron or an open database - the unit tests bundle it
 * for plain Node.
 *
 * Messages that reach the user are translated. Log lines stay English: they are
 * for whoever reads the bug report, not for the person using the app.
 */
let current: Language = DEFAULT_LANGUAGE

export function setMainLanguage(language: string | null | undefined): void {
  current = isLanguage(language) ? language : DEFAULT_LANGUAGE
}

export function mainLanguage(): Language {
  return current
}

export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(current, key, vars)
}
