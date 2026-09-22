import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { api, formatBytes } from './api'
import { useApp, type Screen } from './state/store'
import { screenVariants, snappy, springy, toastVariants } from './lib/motion'
import { Icon } from './components/icons'
import { GamePicker } from './components/GamePicker'
import { UpdateNotice } from './components/UpdateNotice'
import { useT } from './lib/i18n'
import { Button, ErrorNote, Progress } from './components/ui'
import { AccessBanner } from './components/AccessBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Setup } from './components/Setup'
import { InstallPlanDialog } from './components/InstallPlanDialog'
import { ProfilesScreen, SwitchBlockedDialog } from './screens/Profiles'
import { LibraryScreen } from './screens/Library'
import { BrowseScreen } from './screens/Browse'
import { ConflictsScreen } from './screens/Conflicts'
import { HealthScreen } from './screens/Health'
import { SavesScreen } from './screens/Saves'
import { SettingsScreen } from './screens/Settings'
import mark from './assets/mark.png'

const NAV: {
  id: Screen
  icon: keyof typeof Icon
  group: 'setup' | 'manage' | 'system'
}[] = [
  { id: 'profiles', icon: 'profiles', group: 'setup' },
  { id: 'library', icon: 'library', group: 'setup' },
  { id: 'browse', icon: 'browse', group: 'setup' },
  { id: 'conflicts', icon: 'conflicts', group: 'manage' },
  { id: 'health', icon: 'health', group: 'manage' },
  { id: 'saves', icon: 'saves', group: 'manage' },
  { id: 'settings', icon: 'settings', group: 'system' }
]

export function App(): JSX.Element {
  const t = useT()
  const state = useApp()
  const [launching, setLaunching] = useState(false)

  useEffect(() => {
    void state.init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!state.ready) {
    return (
      <div className="empty" style={{ height: '100vh', border: 'none', background: 'var(--bg)' }}>
        <motion.img
          src={mark}
          width={44}
          height={44}
          alt=""
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={springy}
          style={{ borderRadius: 12 }}
        />
        <span className="faint">Opening the vault…</span>
      </div>
    )
  }

  if (state.bootError) {
    return (
      <div className="content" style={{ maxWidth: 620, margin: '80px auto' }}>
        <ErrorNote message={state.bootError} onRetry={() => void state.init()} />
      </div>
    )
  }

  if (!state.game) {
    return (
      <div className="main">
        <Setup />
        <Toasts />
      </div>
    )
  }

  async function launch(): Promise<void> {
    setLaunching(true)
    try {
      const r = await api.launch()
      state.pushToast(r.launched ? 'success' : 'error', r.message)
      await state.refreshProfiles()
    } catch (e) {
      state.pushToast('error', (e as Error).message)
    } finally {
      setLaunching(false)
    }
  }

  const groups: { key: 'setup' | 'manage' | 'system'; label: string }[] = [
    { key: 'setup', label: t('nav.setup') },
    { key: 'manage', label: t('nav.manage') },
    { key: 'system', label: t('nav.system') }
  ]

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src={mark} alt="" />
          <div style={{ lineHeight: 1.25 }}>
            <div className="brand-name">Modão</div>
            <div className="brand-sub">{t('app.tagline')}</div>
          </div>
        </div>

        <GamePicker />

        {groups.map((g) => (
          <div key={g.key}>
            <div className="nav-label">{g.label}</div>
            {NAV.filter((n) => n.group === g.key).map((n) => {
              const NavIcon = Icon[n.icon]
              const active = state.screen === n.id
              return (
                <button key={n.id} className="nav-item" aria-current={active} onClick={() => state.setScreen(n.id)}>
                  {active ? <motion.span layoutId="nav-bar" className="nav-active-bar" transition={springy} /> : null}
                  <NavIcon className="nav-icon" />
                  {t(`nav.${n.id}`)}
                  {n.id === 'library' && state.profile ? (
                    state.unmanaged ? (
                      <span
                        className="nav-tail alert"
                        title={`${state.unmanaged.total} mod(s) in the game folder are not tracked yet`}
                      >
                        !
                      </span>
                    ) : (
                      <span className="nav-tail num">{state.profile.enabledCount}</span>
                    )
                  ) : null}
                  {n.id === 'saves' && state.orphanSaves ? <span className="nav-tail alert">!</span> : null}
                </button>
              )
            })}
          </div>
        ))}

        <div className="sidebar-foot">
          <AnimatePresence initial={false}>
            {state.tasks.map((t) => (
              <motion.div
                key={t.taskId}
                className="task"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0, marginTop: -6 }}
                transition={snappy}
              >
                <div className="row between">
                  <span className="ellipsis" style={{ fontSize: 12 }} title={`${t.label} — ${t.phase}`}>
                    {t.label}
                  </span>
                  {t.cancellable ? (
                    <Button size="sm" variant="quiet" onClick={() => void api.cancelTask(t.taskId)}>
                      stop
                    </Button>
                  ) : null}
                </div>
                <Progress value={t.total ? (t.current / t.total) * 100 : 4} />
                <span className="faint num">
                  {t.phase}
                  {t.total > 1 ? ` · ${t.current}/${t.total}` : ''}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>

          <div className="row between faint" style={{ paddingTop: 2 }}>
            <span className="ellipsis" title={state.game.path}>
              {state.game.label}
            </span>
            <span className="num">{formatBytes(state.profile?.totalSize ?? 0)}</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{t(`nav.${state.screen}`)}</h1>
            <span className="crumb">{t(`shell.subtitle.${state.screen}`)}</span>
          </div>
          <span className="spacer" />

          {state.profile ? (
            <label className="row" style={{ gap: 6 }}>
              <span className="tiny-caps">{t('nav.profiles')}</span>
              <select
                className="select"
                style={{ width: 216 }}
                value={state.profile.id}
                onChange={(e) => void state.activateProfile(Number(e.target.value))}
              >
                {state.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.enabledCount}/{p.modCount}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <Button variant="primary" onClick={launch} disabled={launching} icon={<Icon.play width={12} height={12} />}>
            {launching ? t('shell.launching') : t('shell.launch')}
          </Button>
        </header>

        <div className="content">
          <AccessBanner />
          <UpdateNotice />
          {/*
            No exit animation on screen changes: AnimatePresence has to keep the
            outgoing screen mounted while it fades, and a screen that re-renders
            mid-exit (a mod toggling, a list reloading) could be left stuck at
            opacity 0 - a blank page that only a restart cleared. A keyed
            fade-in gives the same feel with no state to get stuck in.
          */}
          <motion.div key={state.screen} variants={screenVariants} initial="initial" animate="animate">
            <ErrorBoundary resetKey={state.screen}>
              {state.screen === 'profiles' ? <ProfilesScreen /> : null}
              {state.screen === 'library' ? <LibraryScreen /> : null}
              {state.screen === 'browse' ? <BrowseScreen /> : null}
              {state.screen === 'conflicts' ? <ConflictsScreen /> : null}
              {state.screen === 'health' ? <HealthScreen /> : null}
              {state.screen === 'saves' ? <SavesScreen /> : null}
              {state.screen === 'settings' ? <SettingsScreen /> : null}
            </ErrorBoundary>
          </motion.div>
        </div>
      </div>

      <AnimatePresence>
        {state.plan ? <InstallPlanDialog onDone={() => void state.refreshProfiles()} /> : null}
      </AnimatePresence>
      {/*
        A switch that did not reconcile is refused, and the user has to see the
        report wherever they switched from - the header select reaches every
        screen, and it used to discard the verification entirely.
      */}
      <AnimatePresence>
        <SwitchBlockedDialog />
      </AnimatePresence>
      <Toasts />
    </div>
  )
}

function Toasts(): JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="toasts">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className="toast"
            data-kind={t.kind}
            variants={toastVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            layout
          >
            <span className="bar" />
            <span style={{ flex: 1 }}>{t.message}</span>
            <Button
              size="sm"
              variant="quiet"
              iconOnly
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              icon={<Icon.close />}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
