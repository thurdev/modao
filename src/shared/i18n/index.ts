import { ptBR } from './pt-BR'
import { en } from './en'

/**
 * Modão is written for the Brazilian MixMods community, so Portuguese is the
 * source language and English is the translation - not the other way round. The
 * pt-BR catalogue is the one that types every key; a missing English string
 * falls back to it rather than showing a raw key to the user.
 */
export type Language = 'pt-BR' | 'en'

export const LANGUAGES: { id: Language; label: string; nativeLabel: string }[] = [
  { id: 'pt-BR', label: 'Portuguese (Brazil)', nativeLabel: 'Português (Brasil)' },
  { id: 'en', label: 'English', nativeLabel: 'English' }
]

export const DEFAULT_LANGUAGE: Language = 'pt-BR'

/** The catalogue shape, taken from the language that has every key. */
export type Messages = typeof ptBR
export type MessageKey = NestedKeys<Messages>

type NestedKeys<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${NestedKeys<T[K]>}`
}[keyof T & string]

const CATALOGUES: Record<Language, unknown> = { 'pt-BR': ptBR, en }

export function isLanguage(value: unknown): value is Language {
  return value === 'pt-BR' || value === 'en'
}

function lookup(catalogue: unknown, key: string): string | undefined {
  let node: unknown = catalogue
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

/**
 * Looks a message up and fills its placeholders.
 *
 * Placeholders are `{name}`. A count can select a plural form by suffixing the
 * key with `_one` / `_other`, which covers both languages here without pulling
 * in an ICU library for a desktop app that needs two of them.
 */
export function translate(language: Language, key: string, vars?: Record<string, string | number>): string {
  const count = vars?.['count']
  const candidates =
    typeof count === 'number' ? [`${key}_${count === 1 ? 'one' : 'other'}`, key] : [key]

  let message: string | undefined
  for (const candidate of candidates) {
    message = lookup(CATALOGUES[language], candidate) ?? lookup(CATALOGUES[DEFAULT_LANGUAGE], candidate)
    if (message !== undefined) break
  }
  // A key with no message is a bug, but shouting it at the user helps nobody:
  // show the last segment, which reads as words far more often than not.
  if (message === undefined) return key.split('.').pop() ?? key

  if (!vars) return message
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name]
    return value === undefined ? whole : String(value)
  })
}

/** Every key the pt-BR catalogue defines, for the completeness check in tests. */
export function allKeys(catalogue: unknown = ptBR, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(catalogue as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.push(path)
    else if (value && typeof value === 'object') out.push(...allKeys(value, path))
  }
  return out
}

export { ptBR, en }
