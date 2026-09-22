import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { AppSettings, CacheKind, GameInstall, UpdateStatus } from '@shared/types'
import { api, formatBytes, formatDate, relativeTime } from '../api'
import { useApp } from '../state/store'
import { LANGUAGES } from '@shared/i18n'
import { useT } from '../lib/i18n'
import { Button, Confirm, ErrorNote, Field, Loading, Switch, useAsync } from '../components/ui'
import { Icon } from '../components/icons'
import { itemVariants, listVariants } from '../lib/motion'

export function SettingsScreen(): JSX.Element {
  const t = useT()
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  // The screen shows what the last check found, without starting a new one.
  useEffect(() => {
    void api.checkUpdate().then(setUpdate).catch(() => undefined)
  }, [])
  const { settings, setSetting, games, game, refreshGames, pushToast, profiles } = useApp()
  const storage = useAsync(() => api.storage(), [])
  const seed = useAsync(() => api.seedInfo(), [])
  const versions = useAsync(() => api.versions(), [])
  const [removing, setRemoving] = useState<GameInstall | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  if (!settings) return <Loading label="Reading settings…" />

  async function clear(kind: CacheKind): Promise<void> {
    setBusy(kind)
    try {
      await api.clearCache(kind)
      storage.reload()
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <motion.div variants={listVariants} initial="initial" animate="animate" className="col" style={{ gap: 18, maxWidth: 980 }}>
      <motion.div variants={itemVariants} className="page-head">
        <h2>Settings</h2>
        <p>
          Modão works fully offline: the catalog ships with the app and nothing is fetched unless you ask for it.
          Everything below is stored in this machine&apos;s Modão database, never sent anywhere.
        </p>
      </motion.div>

      {/* ── appearance ─────────────────────────────────────────── */}
      <motion.section variants={itemVariants} className="card">
        <div className="card-head">
          <h3>{t('settings.appearance')}</h3>
        </div>
        <Row
          title={t('settings.language')}
          desc={t('settings.languageHint')}
          control={
            <select
              className="select"
              style={{ width: 175 }}
              value={settings.language}
              onChange={(e) => void setSetting('language', e.target.value as AppSettings['language'])}
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nativeLabel}
                </option>
              ))}
            </select>
          }
        />
        <Row
          title={t('settings.theme')}
          desc={t('settings.themeHint')}
          control={
            <select
              className="select"
              style={{ width: 175 }}
              value={settings.theme}
              onChange={(e) => void setSetting('theme', e.target.value as AppSettings['theme'])}
            >
              <option value="system">{t('settings.themeSystem')}</option>
              <option value="dark">{t('settings.themeDark')}</option>
              <option value="light">{t('settings.themeLight')}</option>
            </select>
          }
        />
      </motion.section>

      {/* ── updates ─────────────────────────────────────────── */}
      <motion.section variants={itemVariants} className="card">
        <div className="card-head">
          <h3>{t('updates.title')}</h3>
          <span className="spacer" />
          <span className="faint">
            {update?.error
              ? t('updates.failed', { error: update.error })
              : update?.available
                ? t('updates.found', { version: update.latest ?? '', current: update.current })
                : update
                  ? t('updates.upToDate', { current: update.current })
                  : ''}
          </span>
        </div>
        <Row
          title={t('updates.checkOnStart')}
          desc={t('updates.checkOnStartDesc')}
          control={
            <Switch
              on={settings.checkUpdatesOnStart}
              label={t('updates.checkOnStart')}
              onChange={(v: boolean) => void setSetting('checkUpdatesOnStart', v)}
            />
          }
        />
        <Row
          title={t('updates.title')}
          desc={
            update?.checkedAt ? t('updates.lastChecked', { when: relativeTime(update.checkedAt, t) }) : t('updates.never')
          }
          control={
            <span className="row">
              <Button
                size="sm"
                disabled={checking}
                icon={<Icon.refresh width={13} height={13} />}
                onClick={async () => {
                  setChecking(true)
                  try {
                    setUpdate(await api.checkUpdate(true))
                  } finally {
                    setChecking(false)
                  }
                }}
              >
                {checking ? t('updates.checking') : t('updates.check')}
              </Button>
              {update?.available && update.releaseUrl ? (
                <Button
                  size="sm"
                  variant="accent"
                  icon={<Icon.external width={13} height={13} />}
                  onClick={() => void api.openExternal(update.releaseUrl!)}
                >
                  {t('updates.open')}
                </Button>
              ) : null}
            </span>
          }
        />
      </motion.section>

      {/* ── catalog ─────────────────────────────────────────── */}
      <motion.section variants={itemVariants} className="card">
        <div className="card-head">
          <h3>{t('settings.catalog')}</h3>
          <span className="spacer" />
          <span className="faint">
            {seed.data ? t('settings.modsIndexed', { count: seed.data.count }) : ''}
            {seed.data?.lastCrawl
              ? t('settings.lastCrawl', { date: formatDate(seed.data.lastCrawl) })
              : t('settings.neverCrawled')}
          </span>
        </div>
        <Row
          title={t('settings.indexTitle')}
          desc={t('settings.indexDesc')}
          control={
            <Switch
              label="Enable catalog crawling"
              on={settings.crawlEnabled}
              onChange={(v) => void setSetting('crawlEnabled', v)}
            />
          }
        />
        <Row
          title={t('settings.pagesPerRun')}
          desc={t('settings.pagesPerRunDesc')}
          control={
            <input
              className="input num"
              style={{ width: 92, textAlign: 'center' }}
              type="number"
              min={0}
              max={5000}
              value={settings.crawlMaxPages}
              onChange={(e) => void setSetting('crawlMaxPages', Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
            />
          }
        />
        <Row
          title={t('settings.catalogData')}
          desc={t('settings.catalogDataDesc')}
          control={
            <div className="row">
              <Button
                size="sm"
                icon={<Icon.refresh width={13} height={13} />}
                onClick={async () => {
                  const r = await api.reseed()
                  seed.reload()
                  pushToast('success', `Seed catalog reloaded: ${r.count} mods.`)
                }}
              >
                {t('settings.reloadSeed')}
              </Button>
              <Button
                size="sm"
                variant={settings.crawlEnabled ? 'primary' : 'default'}
                icon={<Icon.download width={13} height={13} />}
                onClick={async () => {
                  const r = await api.crawl()
                  pushToast(r.started ? 'info' : 'error', r.message)
                }}
              >
                {t('settings.indexNow')}
              </Button>
            </div>
          }
        />
      </motion.section>

      {/* ── behaviour ─────────────────────────────────────────── */}
      <motion.section variants={itemVariants} className="card">
        <div className="card-head">
          <h3>{t('settings.behaviour')}</h3>
        </div>
        <Row
          title={t('settings.scanCrashes')}
          desc={t('settings.scanCrashesDesc')}
          control={
            <Switch
              label="Scan for crashes on launch"
              on={settings.scanCrashesOnLaunch}
              onChange={(v) => void setSetting('scanCrashesOnLaunch', v)}
            />
          }
        />
        <Row
          title={t('settings.autoSnapshot')}
          desc={t('settings.autoSnapshotDesc')}
          control={
            <Switch
              label="Automatic save snapshots"
              on={settings.autoSnapshotSaves}
              onChange={(v) => void setSetting('autoSnapshotSaves', v)}
            />
          }
        />
        <Row
          title={t('settings.telemetry')}
          desc={t('settings.telemetryDesc')}
          control={
            <Switch
              label="Local telemetry"
              on={settings.telemetryEnabled}
              onChange={(v) => void setSetting('telemetryEnabled', v)}
            />
          }
        />
      </motion.section>

      {/* ── game folders ─────────────────────────────────────────── */}
      <motion.section variants={itemVariants} className="card">
        <div className="card-head">
          <h3>{t('settings.gameFolders')}</h3>
          <span className="spacer" />
          <Button
            size="sm"
            icon={<Icon.plus width={13} height={13} />}
            onClick={async () => {
              const picked = await api.pickGameFolder()
              if (!picked) return
              try {
                await api.addGame(picked)
                await refreshGames()
                pushToast('success', 'Game folder added.')
              } catch (e) {
                pushToast('error', (e as Error).message)
              }
            }}
          >
            {t('settings.addFolder')}
          </Button>
        </div>
        <div className="card-body col">
          {games.map((g) => (
            <div key={g.id} className="row between" style={{ gap: 14 }}>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 7 }}>
                  <strong>{g.label}</strong>
                  {g.id === game?.id ? <span className="badge accent">active</span> : null}
                  {g.isV1UsOriginal ? <span className="badge ok">v1.0 US</span> : <span className="badge warn">patched exe</span>}
                  {g.largeAddressAware ? <span className="badge">4 GB aware</span> : <span className="badge">2 GB limit</span>}
                </div>
                <div className="faint mono ellipsis" title={g.path}>
                  {g.path}
                </div>
                <div className="faint">
                  ASI directory: {g.asiDirectory ?? 'none detected'} · Mod Loader {g.modLoaderVersion ?? 'not installed'} · CLEO{' '}
                  {g.cleoVersion ?? 'not installed'} ·{' '}
                  {g.sameVolumeAsStore ? 'same volume as the mod store' : 'different volume — switches fall back to copying'}
                </div>
              </div>
              <div className="row">
                <Button size="sm" variant="quiet" icon={<Icon.folder width={13} height={13} />} onClick={() => void api.revealPath(g.path)}>
                  Open
                </Button>
                {g.id !== game?.id ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      await api.setActiveGame(g.id)
                      await refreshGames()
                    }}
                  >
                    {t('settings.useThis')}
                  </Button>
                ) : null}
                <Button size="sm" variant="quiet" iconOnly aria-label={t('settings.forget')} onClick={() => setRemoving(g)} icon={<Icon.trash />} />
              </div>
            </div>
          ))}
        </div>
      </motion.section>

      {/* ── storage ─────────────────────────────────────────── */}
      <motion.section variants={itemVariants} className="card">
        <div className="card-head">
          <h3>{t('settings.storage')}</h3>
          <span className="spacer" />
          {storage.data ? (
            <span className="faint mono ellipsis" title={storage.data.userData}>
              {storage.data.userData}
            </span>
          ) : null}
        </div>
        <div className="card-body col">
          {storage.loading ? <Loading /> : null}
          {storage.error ? <ErrorNote message={storage.error} onRetry={storage.reload} /> : null}
          {storage.data ? (
            <>
              <StorageBar report={storage.data} />
              <div className="row wrap" style={{ gap: 14 }}>
                <Legend label="Mod store" value={storage.data.storeBytes} color="var(--accent)" />
                <Legend label="Downloads" value={storage.data.archivesBytes} color="var(--text-faint)" />
                <Legend label="Save snapshots" value={storage.data.snapshotBytes} color="var(--ok)" />
                <Legend label="Quarantine" value={storage.data.quarantineBytes} color="var(--danger)" />
                <Legend label="Page cache" value={storage.data.cacheBytes} color="var(--border-strong)" />
                <Legend label="Database" value={storage.data.dbBytes} color="var(--text-dim)" />
              </div>
              <p className="faint" style={{ margin: 0 }}>
                The mod store holds one copy of every mod payload; profiles link to it rather than duplicating files.
                Quarantine holds files Modão refused to delete — displaced originals and pruned save snapshots. Emptying
                it is irreversible.
              </p>
              <div className="row wrap">
                <Button size="sm" disabled={busy === 'http'} onClick={() => void clear('http')}>
                  {t('settings.clearPageCache')}
                </Button>
                <Button size="sm" disabled={busy === 'archives'} onClick={() => void clear('archives')}>
                  {t('settings.deleteArchives')}
                </Button>
                <Button size="sm" variant="danger" disabled={busy === 'quarantine'} onClick={() => void clear('quarantine')}>
                  {t('settings.emptyQuarantine')}
                </Button>
                <span className="spacer" />
                <Button size="sm" variant="quiet" onClick={() => void api.revealPath(storage.data!.userData)}>
                  Show in Explorer
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </motion.section>

      {/* ── about ─────────────────────────────────────────── */}
      <motion.section variants={itemVariants} className="card pad">
        <dl className="kv">
          <dt>Modão</dt>
          <dd className="num">{versions.data?.app ?? '—'}</dd>
          <dt>Electron / Node</dt>
          <dd className="num">
            {versions.data?.electron ?? '—'} / {versions.data?.node ?? '—'}
          </dd>
          <dt>Profiles</dt>
          <dd className="num">{profiles.length}</dd>
          <dt>Attribution</dt>
          <dd>
            Mods are indexed from mixmods.com.br and always linked back to their author&apos;s page. Modão mirrors
            nothing and never modifies gta_sa.exe.
          </dd>
        </dl>
      </motion.section>

      {removing ? (
        <Confirm
          title={`Forget ${removing.label}?`}
          danger
          confirmLabel="Forget folder"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await api.removeGame(removing.id)
              await refreshGames()
              pushToast('success', 'Game folder forgotten. Nothing on disk was touched.')
            } catch (e) {
              pushToast('error', (e as Error).message)
            }
            setRemoving(null)
          }}
          body={
            <p>
              Modão stops tracking this install. No file in <span className="mono">{removing.path}</span> is moved or
              deleted, and the mod payloads stay in the store.
            </p>
          }
        />
      ) : null}
    </motion.div>
  )
}

function Row(props: { title: string; desc: string; control: React.ReactNode }): JSX.Element {
  const t = useT()
  return (
    <div className="setting-row">
      <div>
        <div className="title">{props.title}</div>
        <div className="desc">{props.desc}</div>
      </div>
      {props.control}
    </div>
  )
}

function StorageBar(props: {
  report: { storeBytes: number; archivesBytes: number; snapshotBytes: number; quarantineBytes: number; cacheBytes: number; dbBytes: number }
}): JSX.Element {
  const t = useT()
  const r = props.report
  const parts = [
    { v: r.storeBytes, c: 'var(--accent)' },
    { v: r.archivesBytes, c: 'var(--text-faint)' },
    { v: r.snapshotBytes, c: 'var(--ok)' },
    { v: r.quarantineBytes, c: 'var(--danger)' },
    { v: r.cacheBytes, c: 'var(--border-strong)' },
    { v: r.dbBytes, c: 'var(--text-dim)' }
  ]
  const total = parts.reduce((a, p) => a + p.v, 0) || 1
  return (
    <div className="storage-bar" title={`${formatBytes(total)} total`}>
      {parts.map((p, i) => (
        <motion.span
          key={i}
          initial={{ width: 0 }}
          animate={{ width: `${(p.v / total) * 100}%` }}
          transition={{ duration: 0.4, delay: i * 0.04 }}
          style={{ background: p.c }}
        />
      ))}
    </div>
  )
}

function Legend(props: { label: string; value: number; color: string }): JSX.Element {
  const t = useT()
  return (
    <span className="row" style={{ gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: props.color }} />
      <span className="faint">{props.label}</span>
      <span className="num">{formatBytes(props.value)}</span>
    </span>
  )
}
