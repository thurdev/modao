import type { ptBR } from './pt-BR'

/**
 * English catalogue. pt-BR is the source language: anything missing here falls
 * back to it, so a partial translation degrades to Portuguese rather than to a
 * raw key. The type below keeps every key honest - it cannot invent one that
 * does not exist in the source.
 */
type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> }

import { profiles } from './sections/profiles'
import { library } from './sections/library'
import { conflicts } from './sections/conflicts'
import { browse } from './sections/browse'
import { saves } from './sections/saves'
import { health } from './sections/health'
import { settings } from './sections/settings'
import { shell } from './sections/shell'
import { install } from './sections/install'

export const en: DeepPartial<typeof ptBR> = {
  profiles: profiles.en,
  library: library.en,
  conflicts: conflicts.en,
  browse: browse.en,
  saves: saves.en,
  health: health.en,
  settings: settings.en,
  shell: shell.en,
  install: install.en,
  app: {
    name: 'Modão',
    tagline: 'mod manager',
    loading: 'Loading…',
    retry: 'Try again',
    cancel: 'Cancel',
    close: 'Close',
    done: 'Done',
    save: 'Save',
    remove: 'Remove',
    confirm: 'Confirm',
    back: 'Back',
    search: 'Search',
    none: 'none',
    unknown: 'unknown',
    copy: 'Copy',
    open: 'Open',
    details: 'Details',
    working: 'Working…',
    wentWrong: 'Something went wrong'
  },
  nav: {
    setup: 'Set up',
    manage: 'Diagnose',
    system: 'App',
    profiles: 'Profiles',
    library: 'Library',
    browse: 'Browse',
    conflicts: 'Conflicts',
    health: 'Health',
    saves: 'Saves',
    settings: 'Settings'
  },
  game: {
    none: 'No game selected',
    addFirst: 'Add your install to begin',
    addAnother: 'Add another install',
    addAnotherHint: 'San Andreas, III, Vice City or the Definitive Edition',
    onlyOne: 'Only one install so far. Modão manages {list}.',
    pickFolder: 'Select your GTA folder (San Andreas, III, Vice City or the Definitive Edition)',
    notFound: 'No GTA executable in {path}.',
    launch: 'Play',
    added: '{name} added from {path}.',
    switchFirst: '{profile} is a {game} profile and the active install is {active}. Switch to that game first.'
  },
  crashes: {
    title: 'Crash history',
    scan: 'Scan for crashes',
    scanning: 'Reading the Event Log…',
    none: 'No crashes recorded',
    when: 'When',
    kind: 'Kind',
    module: 'Faulting module',
    address: 'Address',
    matchedCause: 'Matched cause',
    notInList: 'not in CrashList',
    notLookedUp: 'not looked up — the fault is not in gta_sa.exe',
    unloaded: 'unloaded',
    unloadedTitle: 'Already unloaded when the fault hit',
    hang: 'Stopped responding — no exception was logged',
    exception: 'Unhandled exception',
    oneRun: 'Unhandled exception · {count} record(s) from one run of the game',
    otherRecords: 'Other records from the same run',
    rawEvent: 'Raw event',
    occurred: 'Occurred',
    process: 'Faulting process',
    exceptionCode: 'Exception code',
    faultOffset: 'Fault offset',
    crashAddress: 'Crash address',
    faultLocation: 'Fault location',
    notLookedUpTitle: 'Not looked up'
  },
  download: {
    noLink: 'No download link is recorded for this release.',
    invalidLink: 'The recorded download link is not a valid URL.',
    landingHost: '{host} serves a download page rather than the file itself, and refuses requests that are not a browser.',
    notARelease: 'That GitHub link is not a release.',
    notAnArchive: '{host} did not give a link ending in .7z, .zip or .rar.'
  },
  errors: {
    noGame: 'No game folder selected. Add a GTA install first.',
    profileGone: 'That profile no longer exists.',
    noBackup: 'There is no switch with a backup to restore from.'
  }
}
