import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { api, formatBytes, relativeTime } from '../api'
import { useApp } from '../state/store'
import { useT } from '../lib/i18n'
import { Badge, Button, Confirm, Empty, ErrorNote, Loading, useAsync } from '../components/ui'
import { Icon } from '../components/icons'
import { itemVariants, listVariants, snappy } from '../lib/motion'

/**
 * Saves screen: what is in the live save folder right now, every snapshot the
 * profile owns, and a way to claim save games that predate Modão instead of
 * letting a profile switch overwrite them.
 */
export function SavesScreen(): JSX.Element {
  const t = useT()
  const { profile, pushToast, game, orphanSaves } = useApp()
  const [label, setLabel] = useState('')
  const [restoring, setRestoring] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [importing, setImporting] = useState(false)

  const snapshots = useAsync(async () => (profile ? api.saves(profile.id) : []), [profile?.id])
  const live = useAsync(async () => (profile ? api.currentSlots(profile.id) : null), [profile?.id])

  if (!profile) {
    return <Empty title={t('saves.noProfileTitle')} hint={t('saves.noProfileHint')} />
  }

  async function importOrphans(): Promise<void> {
    if (!profile) return
    setImporting(true)
    try {
      const r = await api.importExistingSaves(profile.id, t('saves.importedLabel'))
      await useApp.getState().checkOrphanSaves()
      snapshots.reload()
      live.reload()
      pushToast('success', t('saves.importedCount', { count: r.slots, profile: profile.name }))
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  async function snapshotNow(): Promise<void> {
    if (!profile) return
    setBusy(true)
    try {
      await api.snapshot(profile.id, label || t('saves.manualSnapshotLabel'))
      setLabel('')
      snapshots.reload()
      pushToast('success', t('saves.snapshotTaken'))
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <AnimatePresence initial={false}>
        {orphanSaves ? (
          <motion.div
            key="orphans"
            className="notice"
            data-kind="warn"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={snappy}
            style={{ marginBottom: 16 }}
          >
            <span className="notice-mark" />
            <div className="col" style={{ gap: 7 }}>
              <strong>{t('saves.orphanTitle', { count: orphanSaves.slots })}</strong>
              <span className="muted">
                {t('saves.orphanHintBefore')} <span className="mono">{orphanSaves.path}</span>{' '}
                {t('saves.orphanHintMiddle')} <strong>{profile.name}</strong> {t('saves.orphanHintAfter')}
              </span>
              <div className="row">
                <Button
                  variant="accent"
                  disabled={importing}
                  onClick={() => void importOrphans()}
                  icon={<Icon.download width={13} height={13} />}
                >
                  {importing ? t('saves.importing') : t('saves.importInto', { profile: profile.name })}
                </Button>
                <Button variant="quiet" onClick={() => void api.revealPath(orphanSaves.path)} icon={<Icon.folder width={13} height={13} />}>
                  {t('saves.showFolder')}
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="page-head">
        <p>
          {t('saves.introBefore')}{' '}
          <span className="mono">{game?.userFilesDir ?? 'Documents\\GTA San Andreas User Files'}</span>.{' '}
          {t('saves.introAfter')}
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <Icon.saves width={14} height={14} />
          <h2>{t('saves.liveFolderTitle')}</h2>
          <span className="faint num">
            {live.data
              ? t('saves.slotCountAndSize', { count: live.data.slots.length, size: formatBytes(live.data.size) })
              : t('saves.empty')}
          </span>
          <span className="spacer" />
          <input
            className="input"
            style={{ width: 220 }}
            placeholder={t('saves.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void snapshotNow()}
          />
          <Button variant="primary" disabled={busy} onClick={() => void snapshotNow()} icon={<Icon.copy width={13} height={13} />}>
            {busy ? t('saves.copying') : t('saves.snapshotNow')}
          </Button>
        </div>

        {live.error ? (
          <div className="card-body">
            <ErrorNote message={live.error} onRetry={live.reload} />
          </div>
        ) : live.loading ? (
          <div className="card-body">
            <Loading label={t('saves.readingLive')} />
          </div>
        ) : live.data && live.data.slots.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>{t('saves.colSlot')}</th>
                <th>{t('saves.colFile')}</th>
                <th style={{ width: 100 }}>{t('saves.colSize')}</th>
                <th style={{ width: 150 }}>{t('saves.colModified')}</th>
              </tr>
            </thead>
            <motion.tbody variants={listVariants} initial="initial" animate="animate">
              {live.data.slots.map((s) => (
                <motion.tr key={s.file} variants={itemVariants}>
                  <td className="num">{s.index}</td>
                  <td className="mono">{s.file}</td>
                  <td className="faint num">{formatBytes(s.size)}</td>
                  <td className="faint">{relativeTime(s.modifiedAt)}</td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        ) : (
          <div className="card-body faint">
            {t('saves.noLiveSlotsBefore')} <span className="mono">GTASAsf*.b</span> {t('saves.noLiveSlotsAfter')}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <Icon.copy width={14} height={14} />
          <h2>{t('saves.snapshotsTitle')}</h2>
          <span className="faint num">
            {t('saves.keptFor', { count: (snapshots.data ?? []).length, profile: profile.name })}
          </span>
          <span className="spacer" />
          <Button size="sm" variant="quiet" onClick={snapshots.reload} icon={<Icon.refresh width={13} height={13} />}>
            {t('saves.refresh')}
          </Button>
        </div>

        {snapshots.error ? (
          <div className="card-body">
            <ErrorNote message={snapshots.error} onRetry={snapshots.reload} />
          </div>
        ) : snapshots.loading ? (
          <div className="card-body">
            <Loading label={t('saves.listing')} />
          </div>
        ) : (snapshots.data ?? []).length === 0 ? (
          <div className="card-body">
            <Empty title={t('saves.noSnapshotsTitle')} hint={t('saves.noSnapshotsHint')} />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>{t('saves.colTaken')}</th>
                <th>{t('saves.colLabel')}</th>
                <th style={{ width: 70 }}>{t('saves.colSlots')}</th>
                <th style={{ width: 100 }}>{t('saves.colSize')}</th>
                <th style={{ width: 120 }}>{t('saves.colKind')}</th>
                <th style={{ width: 180 }} />
              </tr>
            </thead>
            <motion.tbody variants={listVariants} initial="initial" animate="animate">
              {snapshots.data!.map((s) => (
                <motion.tr key={s.id} variants={itemVariants}>
                  <td className="faint">{relativeTime(s.takenAt)}</td>
                  <td className="cell-title">
                    <strong>{s.label}</strong>
                  </td>
                  <td className="num">{s.slots.length}</td>
                  <td className="faint num">{formatBytes(s.size)}</td>
                  <td>
                    <Badge
                      tone={s.auto ? 'neutral' : 'accent'}
                      title={s.auto ? t('saves.autoTitle') : t('saves.manualTitle')}
                    >
                      {s.auto ? t('saves.autoBadge') : t('saves.manualBadge')}
                    </Badge>
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button size="sm" variant="quiet" onClick={() => setRestoring(s.id)} icon={<Icon.upload width={13} height={13} />}>
                        {t('saves.restore')}
                      </Button>
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => void api.revealPath(s.path)}
                        icon={<Icon.folder width={13} height={13} />}
                      >
                        {t('saves.showFiles')}
                      </Button>
                    </div>
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        )}
      </div>

      <AnimatePresence>
        {restoring !== null ? (
          <Confirm
            title={t('saves.restoreTitle')}
            confirmLabel={t('saves.restoreConfirm')}
            busy={restoreBusy}
            onClose={() => setRestoring(null)}
            onConfirm={async () => {
              setRestoreBusy(true)
              try {
                await api.restoreSnapshot(restoring)
                snapshots.reload()
                live.reload()
                setRestoring(null)
                pushToast('success', t('saves.snapshotRestored'))
              } catch (e) {
                pushToast('error', (e as Error).message)
              } finally {
                setRestoreBusy(false)
              }
            }}
            body={
              <p style={{ margin: 0 }} className="muted">
                {t('saves.restoreBody')}
              </p>
            }
          />
        ) : null}
      </AnimatePresence>
    </>
  )
}
