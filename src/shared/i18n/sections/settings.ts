/**
 * Settings strings.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 * Placeholders are `{name}`; a `count` variable selects `_one` / `_other`.
 */
export const settings = {
  pt: {
    title: 'Ajustes',
    appearance: 'Aparência',
    themeHint:
      'Segue o sistema operacional, a não ser que você fixe. Os dois temas foram desenhados, nenhum é o outro invertido.',
    language: 'Idioma',
    languageHint: 'O Modão nasceu em português; o inglês é tradução.',
    theme: 'Tema',
    themeDark: 'Escuro',
    themeLight: 'Claro',
    themeSystem: 'Do sistema'
  },
  en: {
    title: 'Settings',
    appearance: 'Appearance',
    themeHint:
      'Follows the operating system unless you pin it. Both themes are designed, not inverted.',
    language: 'Language',
    languageHint: 'Modão was written in Portuguese; English is the translation.',
    theme: 'Theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    themeSystem: 'Follow the system'
  }
} as const
