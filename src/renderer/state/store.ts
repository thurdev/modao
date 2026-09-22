import { create } from 'zustand'
import type { AppSettings, GameInstall, InstallPlan, Profile, Progress, UnmanagedReport } from '@shared/types'
import { api } from '../api'

export type Screen = 'profiles' | 'library' | 'browse' | 'conflicts' | 'health' | 'saves' | 'settings'

interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  message: string
}

interface AppState {
  ready: boolean
  bootError: string | null
  screen: Screen
  settings: AppSettings | null
  games: GameInstall[]
  game: GameInstall | null
  profiles: Profile[]
  profile: Profile | null
  tasks: Progress[]
  toasts: Toast[]
  plan: InstallPlan | null
  planBusy: boolean
  /** Saves found on this machine that no profile owns yet. */
  orphanSaves: { slots: number; path: string } | null
  /** Mods sitting in the game folder that the active profile does not track. */
  unmanaged: UnmanagedReport | null

  init(): Promise<void>
  setScreen(s: Screen): void
  refreshProfiles(): Promise<void>
  refreshGames(): Promise<void>
  setActiveGame(id: number): Promise<void>
  refreshSettings(): Promise<void>
  checkOrphanSaves(): Promise<void>
  checkUnmanaged(): Promise<void>
  adoptUnmanaged(): Promise<void>
  activateProfile(id: number): Promise<void>
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>
  pushToast(kind: Toast['kind'], message: string): void
  dismissToast(id: number): void
  setPlan(plan: InstallPlan | null): void
  setPlanBusy(busy: boolean): void
}

let toastSeq = 0

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,
  screen: 'profiles',
  settings: null,
  games: [],
  game: null,
  profiles: [],
  profile: null,
  tasks: [],
  toasts: [],
  plan: null,
  planBusy: false,
  orphanSaves: null,
  unmanaged: null,

  async init() {
    api.onProgress((p) => {
      set((s) => {
        const rest = s.tasks.filter((t) => t.taskId !== p.taskId)
        return { tasks: p.done ? rest : [...rest, p] }
      })
      if (p.done && p.error) get().pushToast('error', p.error)
    })
    api.onToast((t) => get().pushToast(t.kind, t.message))

    try {
      const [settings, games, profiles] = await Promise.all([api.settings(), api.games(), api.profiles()])
      const game = games.find((g) => g.id === settings.activeGameId) ?? games[0] ?? null
      const profile = profiles.find((p) => p.isActive) ?? null
      applyTheme(settings.theme)
      set({
        ready: true,
        settings,
        games,
        game,
        profiles,
        profile,
        // Open on the active profile in a working state, not an empty dashboard.
        screen: profile ? 'library' : 'profiles'
      })
      await Promise.all([get().checkOrphanSaves(), get().checkUnmanaged()])
    } catch (e) {
      set({ ready: true, bootError: (e as Error).message })
    }
  },

  setScreen: (screen) => set({ screen }),

  async refreshProfiles() {
    const profiles = await api.profiles()
    set({ profiles, profile: profiles.find((p) => p.isActive) ?? null })
  },

  async refreshGames() {
    const [games, game] = await Promise.all([api.games(), api.activeGame()])
    set({ games, game })
  },

  /**
   * Switching game switches everything under it. Profiles, library, conflicts
   * and saves all belong to one install, so they are reloaded rather than left
   * showing another game's mods.
   */
  async setActiveGame(id: number) {
    await api.setActiveGame(id)
    await get().refreshGames()
    await get().refreshProfiles()
    await Promise.all([get().checkOrphanSaves(), get().checkUnmanaged()])
  },

  async refreshSettings() {
    set({ settings: await api.settings() })
  },

  /**
   * Save games that predate Modão belong to nobody until a profile claims
   * them. Surfacing that immediately is the difference between importing them
   * and overwriting them.
   */
  async checkOrphanSaves() {
    try {
      const report = await api.detectExistingSaves()
      set({
        orphanSaves:
          report.found && report.importedIntoProfileId === null ? { slots: report.slots.length, path: report.path } : null
      })
    } catch {
      set({ orphanSaves: null })
    }
  },

  /**
   * Mods can appear in the game folder without Modão: a profile created by
   * hand starts empty, and installers run outside the app write straight into
   * modloader\. The UI asks after every profile change so the library never
   * silently disagrees with the folder.
   */
  async checkUnmanaged() {
    const profile = get().profile
    if (!profile) {
      set({ unmanaged: null })
      return
    }
    try {
      const report = await api.unmanaged(profile.id)
      set({ unmanaged: report.total > 0 ? report : null })
    } catch {
      set({ unmanaged: null })
    }
  },

  async adoptUnmanaged() {
    const profile = get().profile
    if (!profile) return
    await api.adoptInto(profile.id)
    await Promise.all([get().refreshProfiles(), get().checkUnmanaged()])
  },

  async activateProfile(id) {
    await api.activateProfile(id)
    await get().refreshProfiles()
    await get().checkUnmanaged()
  },

  async setSetting(key, value) {
    const settings = await api.setSetting(key, value)
    if (key === 'theme') applyTheme(settings.theme)
    set({ settings })
  },

  pushToast(kind, message) {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 12000 : 6000)
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  setPlan: (plan) => set({ plan }),
  setPlanBusy: (planBusy) => set({ planBusy })
}))

export function applyTheme(theme: AppSettings['theme']): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}
