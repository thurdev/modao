import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { api, formatBytes, relativeTime } from '../api'
import { useApp } from '../state/store'
import { Badge, Button, Confirm, Empty, ErrorNote, Loading, useAsync } from '../components/ui'
import { Icon } from '../components/icons'
import { itemVariants, listVariants, snappy } from '../lib/motion'

/**
 * Saves screen: what is in the live save folder right now, every snapshot the
 * profile owns, and a way to claim save games that predate Modão instead of
 * letting a profile switch overwrite them.
 */
export function SavesScreen(): JSX.Element {
  const { profile, pushToast, game, orphanSaves } = useApp()
  const [label, setLabel] = useState('')
  const [restoring, setRestoring] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [importing, setImporting] = useState(false)

  const snapshots = useAsync(async () => (profile ? api.saves(profile.id) : []), [profile?.id])
  const live = useAsync(async () => (profile ? api.currentSlots(profile.id) : null), [profile?.id])

  if (!profile) {
    return (
      <Empty
        title="No active profile"
        hint="Save games are kept per profile. Activate one on the Profiles screen and its snapshots will be listed here."
      />
    )
  }

  async function importOrphans(): Promise<void> {
    if (!profile) return
    setImporting(true)
    try {
      const r = await api.importExistingSaves(profile.id, 'Imported from the live save folder')
      await useApp.getState().checkOrphanSaves()
      snapshots.reload()
      live.reload()
      pushToast('success', `${r.slots} save slot${r.slots === 1 ? '' : 's'} imported into ${profile.name}.`)
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
      await api.snapshot(profile.id, label || 'manual snapshot')
      setLabel('')
      snapshots.reload()
      pushToast('success', 'Snapshot taken.')
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
              <strong>
                {orphanSaves.slots} save game{orphanSaves.slots === 1 ? '' : 's'} on this machine belong to no profile
              </strong>
              <span className="muted">
                They were found in <span className="mono">{orphanSaves.path}</span> and predate Modão. Until a
                profile claims them, the next profile switch will move them aside. Import them into{' '}
                <strong>{profile.name}</strong> to keep them, and to be able to restore them later.
              </span>
              <div className="row">
                <Button
                  variant="accent"
                  disabled={importing}
                  onClick={() => void importOrphans()}
                  icon={<Icon.download width={13} height={13} />}
                >
                  {importing ? 'Importing…' : `Import into ${profile.name}`}
                </Button>
                <Button variant="quiet" onClick={() => void api.revealPath(orphanSaves.path)} icon={<Icon.folder width={13} height={13} />}>
                  Show the folder
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="page-head">
        <p>
          Save games live outside the game folder, in{' '}
          <span className="mono">{game?.userFilesDir ?? 'Documents\\GTA San Andreas User Files'}</span>. Each profile
          keeps its own set: switching moves the current saves into the outgoing profile&apos;s store and materialises
          the incoming profile&apos;s in their place. The last 10 automatic snapshots per profile are kept, and nothing
          is ever deleted.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <Icon.saves width={14} height={14} />
          <h2>Live save folder</h2>
          <span className="faint num">
            {live.data ? `${live.data.slots.length} slot${live.data.slots.length === 1 ? '' : 's'} · ${formatBytes(live.data.size)}` : 'empty'}
          </span>
          <span className="spacer" />
          <input
            className="input"
            style={{ width: 220 }}
            placeholder="Snapshot label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void snapshotNow()}
          />
          <Button variant="primary" disabled={busy} onClick={() => void snapshotNow()} icon={<Icon.copy width={13} height={13} />}>
            {busy ? 'Copying…' : 'Snapshot now'}
          </Button>
        </div>

        {live.error ? (
          <div className="card-body">
            <ErrorNote message={live.error} onRetry={live.reload} />
          </div>
        ) : live.loading ? (
          <div className="card-body">
            <Loading label="Reading the live save folder…" />
          </div>
        ) : live.data && live.data.slots.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 70 }}>Slot</th>
                <th>File</th>
                <th style={{ width: 100 }}>Size</th>
                <th style={{ width: 150 }}>Modified</th>
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
            No <span className="mono">GTASAsf*.b</span> files in the live folder yet — the game writes them the first
            time you save.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <Icon.copy width={14} height={14} />
          <h2>Snapshots</h2>
          <span className="faint num">
            {(snapshots.data ?? []).length} kept for {profile.name}
          </span>
          <span className="spacer" />
          <Button size="sm" variant="quiet" onClick={snapshots.reload} icon={<Icon.refresh width={13} height={13} />}>
            Refresh
          </Button>
        </div>

        {snapshots.error ? (
          <div className="card-body">
            <ErrorNote message={snapshots.error} onRetry={snapshots.reload} />
          </div>
        ) : snapshots.loading ? (
          <div className="card-body">
            <Loading label="Listing snapshots…" />
          </div>
        ) : (snapshots.data ?? []).length === 0 ? (
          <div className="card-body">
            <Empty
              title="No snapshots yet"
              hint="One is taken automatically every time you switch profiles; the last 10 automatic ones are kept. Take a manual snapshot before anything risky — nothing is ever deleted, so a restore can always be undone."
            />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 130 }}>Taken</th>
                <th>Label</th>
                <th style={{ width: 70 }}>Slots</th>
                <th style={{ width: 100 }}>Size</th>
                <th style={{ width: 120 }}>Kind</th>
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
                      title={
                        s.auto
                          ? 'Taken by Modão on a profile switch. Only the last 10 automatic snapshots are kept.'
                          : 'Taken by you. Manual snapshots are never rotated out.'
                      }
                    >
                      {s.auto ? 'automatic' : 'manual'}
                    </Badge>
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button size="sm" variant="quiet" onClick={() => setRestoring(s.id)} icon={<Icon.upload width={13} height={13} />}>
                        Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => void api.revealPath(s.path)}
                        icon={<Icon.folder width={13} height={13} />}
                      >
                        Show files
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
            title="Restore this snapshot?"
            confirmLabel="Restore saves"
            busy={restoreBusy}
            onClose={() => setRestoring(null)}
            onConfirm={async () => {
              setRestoreBusy(true)
              try {
                await api.restoreSnapshot(restoring)
                snapshots.reload()
                live.reload()
                setRestoring(null)
                pushToast('success', 'Snapshot restored into the live save folder.')
              } catch (e) {
                pushToast('error', (e as Error).message)
              } finally {
                setRestoreBusy(false)
              }
            }}
            body={
              <p style={{ margin: 0 }} className="muted">
                The current live save folder is snapshotted first, then replaced with this one. Both copies survive —
                nothing is ever deleted — so the restore itself can be undone from this list.
              </p>
            }
          />
        ) : null}
      </AnimatePresence>
    </>
  )
}
