import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { InstalledMod } from '@shared/types'
import { DESTINATION_KEYS, DESTINATION_LABELS } from '@shared/types'
import { api, formatBytes, relativeTime } from '../api'
import { useApp } from '../state/store'
import { useT } from '../lib/i18n'
import { Badge, Button, Checkbox, Confirm, Empty, ErrorNote, Loading, Modal, Search, Stepper, Switch, useAsync } from '../components/ui'
import { Icon } from '../components/icons'
import { itemVariants, listVariants, snappy } from '../lib/motion'
import art from '../assets/empty-library-320.png'

type SortKey = 'title' | 'priority' | 'size' | 'installedAt' | 'conflicts'

export function LibraryScreen(): JSX.Element {
  const t = useT()
  const { profile, pushToast, setPlan, setPlanBusy, planBusy, unmanaged, adoptUnmanaged } = useApp()
  const [adopting, setAdopting] = useState(false)
  const [sort, setSort] = useState<SortKey>('title')
  const [asc, setAsc] = useState(true)
  const [search, setSearch] = useState('')
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [readmeFor, setReadmeFor] = useState<InstalledMod | null>(null)
  const [uninstalling, setUninstalling] = useState<InstalledMod | null>(null)
  const [detail, setDetail] = useState<InstalledMod | null>(null)

  const mods = useAsync(async () => (profile ? api.library(profile.id) : []), [profile?.id])

  const rows = useMemo(() => {
    const q = search.toLowerCase()
    const list = (mods.data ?? []).filter((m) => {
      const matches = !q || m.title.toLowerCase().includes(q) || m.author.toLowerCase().includes(q)
      const problematic = m.conflictCount > 0 || m.updateAvailable
      return matches && (!onlyProblems || problematic)
    })
    const dir = asc ? 1 : -1
    return [...list].sort((a, b) => {
      switch (sort) {
        case 'priority':
          return (a.priority - b.priority) * dir
        case 'size':
          return (a.size - b.size) * dir
        case 'installedAt':
          return a.installedAt.localeCompare(b.installedAt) * dir
        case 'conflicts':
          return (a.conflictCount - b.conflictCount) * dir
        default:
          return a.title.localeCompare(b.title) * dir
      }
    })
  }, [mods.data, sort, asc, search, onlyProblems])

  function Th(props: { id: SortKey; label: string; style?: React.CSSProperties }): JSX.Element {
    return (
      <th
        className="sortable"
        style={props.style}
        onClick={() => {
          if (sort === props.id) setAsc(!asc)
          else {
            setSort(props.id)
            setAsc(true)
          }
        }}
      >
        {props.label}
        {sort === props.id ? (asc ? ' ↑' : ' ↓') : ''}
      </th>
    )
  }

  async function installFromFile(): Promise<void> {
    if (!profile) return
    setPlanBusy(true)
    try {
      const plan = await api.planFromFile(profile.id)
      if (plan) setPlan(plan)
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setPlanBusy(false)
    }
  }

  async function adopt(): Promise<void> {
    setAdopting(true)
    try {
      await adoptUnmanaged()
      mods.reload()
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setAdopting(false)
    }
  }

  /**
   * Every one of these can legitimately fail - the game folder may be
   * read-only, the game may be running, the install may have been removed in
   * another window. A rejected promise inside an onChange handler would
   * otherwise vanish, leaving the switch showing a state the database never
   * took, so each one reports and then re-reads the truth.
   */
  async function toggle(mod: InstalledMod, enabled: boolean): Promise<void> {
    try {
      await api.setEnabled(mod.installId, enabled)
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      mods.reload()
    }
  }

  async function reprioritise(mod: InstalledMod, priority: number): Promise<void> {
    try {
      await api.setPriority(mod.installId, priority)
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      mods.reload()
    }
  }

  async function bulk(enabled: boolean): Promise<void> {
    try {
      for (const id of selected) await api.setEnabled(id, enabled)
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setSelected(new Set())
      mods.reload()
    }
  }

  if (!profile) {
    return <Empty title="No active profile" hint="Activate a profile on the Profiles screen to see what it has installed." />
  }

  const totals = {
    size: rows.reduce((a, m) => a + m.size, 0),
    conflicts: rows.reduce((a, m) => a + m.conflictCount, 0),
    updates: rows.filter((m) => m.updateAvailable).length
  }

  return (
    <>
      <div className="page-head">
        <p>
          {t('library.introBefore')}
          <strong>{profile.name}</strong>
          {t('library.introAfter')}
        </p>
      </div>

      {unmanaged ? (
        <div className="notice" data-kind="warn" style={{ marginBottom: 12 }}>
          <span className="notice-mark" />
          <div className="col" style={{ gap: 8 }}>
            <strong>{t('library.untrackedTitle', { count: unmanaged.total, profile: profile.name })}</strong>
            <span className="faint">
              {[
                unmanaged.folders.length ? t('library.untrackedFolders', { count: unmanaged.folders.length }) : '',
                unmanaged.asi.length ? t('library.untrackedAsi', { count: unmanaged.asi.length }) : '',
                unmanaged.cleo.length ? t('library.untrackedCleo', { count: unmanaged.cleo.length }) : ''
              ]
                .filter(Boolean)
                .join(', ')}
              {' — '}
              {[...unmanaged.folders, ...unmanaged.asi, ...unmanaged.cleo].slice(0, 6).join(', ')}
              {unmanaged.total > 6 ? t('library.untrackedMore', { count: unmanaged.total - 6 }) : ''}.{' '}
              {t('library.untrackedHint')}
            </span>
            <span className="row">
              <Button variant="accent" size="sm" disabled={adopting} onClick={adopt} icon={<Icon.download width={13} height={13} />}>
                {adopting ? t('library.scanning') : t('library.adoptInto', { profile: profile.name })}
              </Button>
            </span>
          </div>
        </div>
      ) : null}

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Search value={search} onChange={setSearch} placeholder={t('library.filterPlaceholder')} />
        <Button
          size="sm"
          variant={onlyProblems ? 'accent' : 'default'}
          onClick={() => setOnlyProblems((v) => !v)}
          icon={<Icon.warn width={13} height={13} />}
        >
          {t('library.needsAttention')}
        </Button>
        <Button variant="primary" icon={<Icon.plus width={13} height={13} />} disabled={planBusy} onClick={installFromFile}>
          {t('library.installFromFile')}
        </Button>
        <span className="spacer" />
        <span className="faint num">
          {t('library.countAndSize', { count: rows.length, size: formatBytes(totals.size) })}
          {totals.conflicts ? t('library.conflictingFiles', { count: totals.conflicts }) : ''}
          {totals.updates ? t('library.updates', { count: totals.updates }) : ''}
        </span>
      </div>

      <AnimatePresence>
        {selected.size > 0 ? (
          <motion.div
            className="card"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={snappy}
            style={{ marginBottom: 10 }}
          >
            <div className="row" style={{ padding: '9px 13px' }}>
              <Badge tone="accent">{t('library.selected', { count: selected.size })}</Badge>
              <Button size="sm" onClick={() => void bulk(true)}>
                {t('library.enable')}
              </Button>
              <Button size="sm" onClick={() => void bulk(false)}>
                {t('library.disable')}
              </Button>
              <span className="spacer" />
              <Button size="sm" variant="quiet" onClick={() => setSelected(new Set())}>
                {t('library.clear')}
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {mods.error ? (
        <ErrorNote message={mods.error} onRetry={mods.reload} />
      ) : mods.loading ? (
        <Loading label={t('library.reading')} />
      ) : rows.length === 0 ? (
        <Empty
          title={search || onlyProblems ? t('library.nothingMatches') : t('library.nothingInstalled')}
          art={art}
          hint={
            search || onlyProblems
              ? t('library.clearFiltersHint')
              : t('library.nothingInstalledHint')
          }
          action={
            search || onlyProblems ? (
              <Button
                size="sm"
                onClick={() => {
                  setSearch('')
                  setOnlyProblems(false)
                }}
              >
                {t('library.clearFilters')}
              </Button>
            ) : (
              <span className="row wrap" style={{ justifyContent: 'center' }}>
                {unmanaged ? (
                  <Button variant="primary" disabled={adopting} onClick={adopt}>
                    {adopting ? t('library.scanning') : t('library.adoptAll', { count: unmanaged.total })}
                  </Button>
                ) : null}
                <Button variant={unmanaged ? 'default' : 'primary'} onClick={installFromFile}>
                  Install from file…
                </Button>
              </span>
            )
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <Checkbox
                    label={t('library.selectAll')}
                    on={selected.size === rows.length && rows.length > 0}
                    onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.installId)) : new Set())}
                  />
                </th>
                <th style={{ width: 46 }}>{t('library.colOn')}</th>
                <Th id="title" label={t('library.colMod')} />
                <th>{t('library.colKind')}</th>
                <Th id="priority" label={t('library.colPriority')} style={{ width: 92 }} />
                <Th id="size" label={t('library.colSize')} style={{ width: 84 }} />
                <th style={{ width: 130 }}>{t('library.colVersion')}</th>
                <Th id="conflicts" label={t('library.colConflicts')} style={{ width: 92 }} />
                <Th id="installedAt" label={t('library.colInstalled')} style={{ width: 104 }} />
                <th style={{ width: 118 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.installId} className={m.enabled ? '' : 'off'}>
                  <td>
                    <Checkbox
                      label={t('library.selectOne', { name: m.title })}
                      on={selected.has(m.installId)}
                      onChange={(v) => {
                        const next = new Set(selected)
                        if (v) next.add(m.installId)
                        else next.delete(m.installId)
                        setSelected(next)
                      }}
                    />
                  </td>
                  <td>
                    <Switch
                      on={m.enabled}
                      label={t('library.enableOne', { name: m.title })}
                      onChange={(v) => void toggle(m, v)}
                    />
                  </td>
                  <td className="cell-title">
                    <button
                      onClick={() => setDetail(m)}
                      style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }}
                    >
                      <strong>{m.title}</strong>
                    </button>
                    <div className="faint ellipsis">
                      {m.author}
                      {m.variantChoice ? ` · ${m.variantChoice}` : ''}
                      {m.subMods.length ? ` · ${m.subMods.length} sub-mod(s)` : ''}
                    </div>
                  </td>
                  <td>
                    <Badge tone={m.destinationClass === 'overlay' ? 'warn' : 'neutral'}>
                      {t(DESTINATION_KEYS[m.destinationClass])}
                    </Badge>
                  </td>
                  <td>
                    <Stepper value={m.priority} onCommit={(v) => void reprioritise(m, v)} />
                  </td>
                  <td className="faint num">{formatBytes(m.size)}</td>
                  <td>
                    <span className="ellipsis" title={m.versionLabel}>
                      {m.versionLabel}
                    </span>
                    {m.updateAvailable ? (
                      <Badge tone="warn" title={`Catalog has ${m.latestVersionLabel}`}>
                        {t('library.updateBadge')}
                      </Badge>
                    ) : null}
                  </td>
                  <td>{m.conflictCount ? <Badge tone="warn">{m.conflictCount}</Badge> : <span className="faint">{t('app.none')}</span>}</td>
                  <td className="faint">{relativeTime(m.installedAt, t)}</td>
                  <td>
                    <div className="row-actions">
                      {m.sourceUrl ? (
                        <Button
                          size="sm"
                          variant="quiet"
                          iconOnly
                          aria-label="Open source page"
                          title={t('library.openPage')}
                          onClick={() => void api.openExternal(m.sourceUrl)}
                          icon={<Icon.external />}
                        />
                      ) : null}
                      <Button
                        size="sm"
                        variant="quiet"
                        iconOnly
                        aria-label="Readme"
                        title={t('library.showReadme')}
                        onClick={() => setReadmeFor(m)}
                        icon={<Icon.doc />}
                      />
                      <Button
                        size="sm"
                        variant="quiet"
                        iconOnly
                        aria-label="Uninstall"
                        title={t('library.uninstall')}
                        onClick={() => setUninstalling(m)}
                        icon={<Icon.trash />}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AnimatePresence>
        {readmeFor ? <ReadmeModal key="readme" mod={readmeFor} onClose={() => setReadmeFor(null)} /> : null}
        {detail ? <DetailModal key="detail" mod={detail} onClose={() => setDetail(null)} onChanged={mods.reload} /> : null}
        {uninstalling ? (
          <UninstallModal
            key="uninstall"
            mod={uninstalling}
            onClose={() => setUninstalling(null)}
            onDone={() => {
              mods.reload()
              setUninstalling(null)
            }}
          />
        ) : null}
      </AnimatePresence>
    </>
  )
}

function ReadmeModal(props: { mod: InstalledMod; onClose: () => void }): JSX.Element {
  const t = useT()
  const readme = useAsync(() => api.readme(props.mod.installId), [props.mod.installId])
  return (
    <Modal
      title={t('library.readmeTitle', { name: props.mod.title })}
      subtitle="Exactly as the archive shipped it, decoded from Windows-1252."
      onClose={props.onClose}
      width={760}
    >
      {readme.loading ? (
        <Loading />
      ) : readme.data ? (
        <pre className="pre" style={{ maxHeight: '58vh' }}>
          {readme.data}
        </pre>
      ) : (
        <p className="faint">{t('library.noReadme')}</p>
      )}
    </Modal>
  )
}

function DetailModal(props: { mod: InstalledMod; onClose: () => void; onChanged: () => void }): JSX.Element {
  const t = useT()
  const m = props.mod
  const pushToast = useApp((s) => s.pushToast)
  const [busy, setBusy] = useState<string | null>(null)
  return (
    <Modal
      title={m.title}
      subtitle={`${m.author} · ${m.fileCount} files · ${formatBytes(m.size)}`}
      onClose={props.onClose}
      width={720}
    >
      <dl className="kv">
        <dt>Destination class</dt>
        <dd>{t(DESTINATION_KEYS[m.destinationClass])}</dd>
        <dt>Priority</dt>
        <dd className="num">
          {m.priority}
          {m.priority === 0 ? ' — ignored by Mod Loader' : m.priority === 50 ? ' — default' : ''}
        </dd>
        <dt>Version</dt>
        <dd>
          {m.versionLabel}
          {m.updateAvailable ? t('library.catalogHas', { version: m.latestVersionLabel ?? '' }) : ''}
        </dd>
        <dt>Variant</dt>
        <dd>{m.variantChoice ?? t('app.none')}</dd>
        <dt>Installed</dt>
        <dd>{relativeTime(m.installedAt, t)}</dd>
        <dt>Conflicts</dt>
        <dd>{m.conflictCount || t('app.none')}</dd>
      </dl>

      {m.variantGroups.map((g) => (
        <div key={g.id} style={{ marginTop: 10 }}>
          <div className="faint">{t('library.variantGroupLabel')}: {g.question}</div>
          <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
            {g.options.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant={o.id === g.chosenOptionId ? 'accent' : undefined}
                disabled={busy === `variant:${g.id}` || o.id === g.chosenOptionId}
                onClick={async () => {
                  setBusy(`variant:${g.id}`)
                  try {
                    await api.setVariant(m.installId, g.id, o.id)
                    props.onChanged()
                  } catch (e) {
                    pushToast('error', (e as Error).message)
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                {busy === `variant:${g.id}` && o.id !== g.chosenOptionId ? t('library.switchingVariant') : o.label}
              </Button>
            ))}
          </div>
        </div>
      ))}

      {m.subMods.length > 0 ? (
        <>
          <hr className="divider" />
          <h3>{t('library.subMods')}</h3>
          <p className="faint">
            Nested folders inside a Mod Loader mod are independent units — Mod Loader treats each as its own mod, so they
            can be turned off one at a time without uninstalling the whole thing.
          </p>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <tbody>
                {m.subMods.map((s) => (
                  <tr key={s.relativePath} className={s.enabled ? '' : 'off'}>
                    <td>{s.relativePath}</td>
                    <td className="faint num">{s.fileCount} files</td>
                    <td className="faint num">{formatBytes(s.size)}</td>
                    <td style={{ width: 96 }}>
                      <Button
                        size="sm"
                        disabled={busy === s.relativePath}
                        onClick={async () => {
                          setBusy(s.relativePath)
                          try {
                            await api.setSubModEnabled(m.installId, s.relativePath, !s.enabled)
                            props.onChanged()
                            props.onClose()
                          } finally {
                            setBusy(null)
                          }
                        }}
                      >
                        {s.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Modal>
  )
}

function UninstallModal(props: { mod: InstalledMod; onClose: () => void; onDone: () => void }): JSX.Element {
  const t = useT()
  const preview = useAsync(() => api.rollbackPreview(props.mod.installId), [props.mod.installId])
  const pushToast = useApp((s) => s.pushToast)
  const [busy, setBusy] = useState(false)
  return (
    <Confirm
      title={t('library.uninstallTitle', { name: props.mod.title })}
      danger
      busy={busy}
      confirmLabel="Uninstall"
      onClose={props.onClose}
      onConfirm={async () => {
        setBusy(true)
        try {
          const r = await api.uninstall(props.mod.installId)
          pushToast(
            'success',
            `Removed. ${r.restored} displaced file(s) restored${
              r.quarantined.length ? `, ${r.quarantined.length} file(s) you had edited moved to quarantine` : ''
            }.`
          )
          props.onDone()
        } catch (e) {
          pushToast('error', (e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
      body={
        <>
          <p>
            Every file this install wrote is removed and anything it displaced is put back byte-for-byte. A file you
            edited after installing is moved to quarantine rather than deleted.
          </p>
          <pre className="pre" style={{ maxHeight: 260 }}>
            {preview.loading
              ? t('library.readingLog')
              : (preview.data ?? []).map((p) => `${p.relativePath}  —  ${p.action}`).join('\n')}
          </pre>
        </>
      }
    />
  )
}
