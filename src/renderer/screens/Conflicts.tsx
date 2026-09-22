import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { FileConflict } from '@shared/types'
import { api, formatBytes } from '../api'
import { useApp } from '../state/store'
import { Badge, Button, Empty, ErrorNote, Loading, Search, Stepper, useAsync } from '../components/ui'
import { Icon } from '../components/icons'
import { itemVariants, listVariants, snappy } from '../lib/motion'
import art from '../assets/empty-conflicts-320.png'

/**
 * Conflicts screen: every duplicated relative path, who wins it, and a live
 * preview of what changing a priority would do — before a single byte is
 * written to modloader.ini.
 */
export function ConflictsScreen(): JSX.Element {
  const { profile, pushToast } = useApp()
  const [overrides, setOverrides] = useState<Record<number, number>>({})
  const [preview, setPreview] = useState<FileConflict[] | null>(null)
  const [filter, setFilter] = useState('')
  const [writing, setWriting] = useState(false)

  const conflicts = useAsync(async () => (profile ? api.conflicts(profile.id) : []), [profile?.id])
  const shown = preview ?? conflicts.data ?? []

  const filtered = useMemo(
    () => shown.filter((c) => !filter || c.relativePath.toLowerCase().includes(filter.toLowerCase())),
    [shown, filter]
  )

  const pending = Object.keys(overrides).length

  async function changePriority(installId: number, priority: number): Promise<void> {
    if (!profile) return
    const next = { ...overrides, [installId]: priority }
    setOverrides(next)
    const changes = Object.entries(next).map(([id, p]) => ({ installId: Number(id), priority: p }))
    try {
      setPreview(await api.previewConflicts(profile.id, changes))
    } catch (e) {
      pushToast('error', (e as Error).message)
    }
  }

  function discard(): void {
    setOverrides({})
    setPreview(null)
  }

  async function commit(): Promise<void> {
    if (!profile) return
    setWriting(true)
    const changes = Object.entries(overrides).map(([id, p]) => ({ installId: Number(id), priority: p }))
    try {
      await api.applyPriorities(profile.id, changes)
      discard()
      conflicts.reload()
      pushToast('success', 'modloader.ini updated with the new load order.')
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setWriting(false)
    }
  }

  if (!profile) {
    return (
      <Empty
        title="No active profile"
        hint="Conflicts are resolved per profile. Activate one on the Profiles screen and its duplicated files will be listed here."
      />
    )
  }

  return (
    <>
      <div className="page-head">
        <p>
          Two mods supplying the same relative filename is not an error — Mod Loader loads exactly one of them, chosen
          by priority. Priority runs from 1 to 100, a fresh install sits at 50, and the higher number wins; 0 means Mod
          Loader ignores the mod for that path entirely. The duplicated files cost disk space, never memory.
        </p>
        <p>
          Change a priority to see the winner recomputed live. Nothing is written to modloader.ini until you apply.
        </p>
      </div>

      <div className="row wrap" style={{ marginBottom: 14 }}>
        <Search value={filter} onChange={setFilter} placeholder="Filter by path, e.g. hud.txd" width={300} />
        <span className="spacer" />
        <span className="faint num">
          {filtered.length} conflicting path{filtered.length === 1 ? '' : 's'}
          {filtered.length !== shown.length ? ` of ${shown.length}` : ''}
        </span>
      </div>

      {conflicts.error ? (
        <ErrorNote message={conflicts.error} onRetry={conflicts.reload} />
      ) : conflicts.loading ? (
        <Loading label="Indexing every installed file…" />
      ) : filtered.length === 0 ? (
        <Empty
          title={filter ? 'Nothing matches that filter' : 'No duplicated files'}
          hint={
            filter
              ? 'No conflicting path contains that text. Clear the filter to see the whole list.'
              : 'Nothing in this profile supplies the same relative path twice. Common real cases when it happens: LOADSCS.txd, ped.ifp, weapon.dat, animgrp.dat, default.ide, hud.txd, fonts.txd.'
          }
          art={art}
          action={
            filter ? (
              <Button size="sm" onClick={() => setFilter('')}>
                Clear filter
              </Button>
            ) : null
          }
        />
      ) : (
        <motion.div variants={listVariants} initial="initial" animate="animate">
          <AnimatePresence initial={false}>
            {pending > 0 ? (
              <motion.div
                key="pending-bar"
                className="card"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={snappy}
                style={{ position: 'sticky', top: 0, zIndex: 3, marginBottom: 9 }}
              >
                <div className="row wrap" style={{ padding: '10px 13px' }}>
                  <Badge tone="accent" dot>
                    {pending} pending priority change{pending === 1 ? '' : 's'}
                  </Badge>
                  <span className="muted">Previewed below. modloader.ini still holds the old load order.</span>
                  <span className="spacer" />
                  <Button size="sm" onClick={discard} disabled={writing}>
                    Discard
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void commit()}
                    disabled={writing}
                    icon={<Icon.check width={13} height={13} />}
                  >
                    {writing ? 'Writing…' : 'Write to modloader.ini'}
                  </Button>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {filtered.map((c) => (
            <motion.div className="conflict" key={c.relativePath} variants={itemVariants}>
              <header>
                <Icon.conflicts width={14} height={14} />
                <span className="mono ellipsis" style={{ flex: 1 }} title={c.relativePath}>
                  {c.relativePath}
                </span>
                <Badge
                  tone={c.kind === 'physical' ? 'warn' : 'accent'}
                  title={
                    c.kind === 'physical'
                      ? 'Both mods wrote the same file on disk, so one physically replaced the other.'
                      : 'Both files stay on disk; Mod Loader picks one of them at load time.'
                  }
                >
                  {c.kind === 'physical' ? 'same file on disk' : 'Mod Loader merge'}
                </Badge>
                <Badge>
                  {c.claimants.length} mod{c.claimants.length === 1 ? '' : 's'}
                </Badge>
              </header>

              {[...c.claimants]
                .sort((a, b) => b.priority - a.priority)
                .map((claim) => {
                  const winner = c.winner?.installId === claim.installId
                  const edited = overrides[claim.installId] !== undefined
                  return (
                    <div className="claimant" data-winner={winner} key={claim.installId}>
                      <div className="col" style={{ gap: 3, minWidth: 0 }}>
                        <div className="row wrap" style={{ gap: 7 }}>
                          <strong className="ellipsis">{claim.title}</strong>
                          {!claim.enabled ? <Badge>disabled</Badge> : null}
                          {claim.priority === 0 ? <Badge tone="warn">ignored — priority 0</Badge> : null}
                          {edited ? (
                            <Badge tone="accent" dot>
                              edited
                            </Badge>
                          ) : null}
                        </div>
                        <span className="faint mono ellipsis" title={claim.sha256}>
                          {claim.sha256.slice(0, 12)}
                        </span>
                      </div>
                      <span className="faint num">{formatBytes(claim.size)}</span>
                      <Stepper
                        value={overrides[claim.installId] ?? claim.priority}
                        min={0}
                        max={100}
                        onCommit={(v) => void changePriority(claim.installId, v)}
                      />
                      <Badge tone={winner ? 'ok' : 'neutral'} dot={winner}>
                        {winner ? 'wins' : 'shadowed'}
                      </Badge>
                    </div>
                  )
                })}

              {c.binaryNotes.length > 0 ? (
                <div style={{ padding: '10px 13px' }}>
                  <div className="notice" data-kind="warn">
                    <span className="notice-mark" />
                    <div className="col" style={{ gap: 4 }}>
                      {c.binaryNotes.map((n, i) => (
                        <span key={i} className="muted">
                          {n}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {!c.winner ? (
                <div style={{ padding: '0 13px 10px' }}>
                  <div className="notice">
                    <span className="notice-mark" />
                    <div className="col" style={{ gap: 4 }}>
                      <strong>No winner — the vanilla file is used</strong>
                      <span className="muted">
                        Every mod claiming this path is either disabled or set to priority 0, so Mod Loader falls back
                        to the file that shipped with the game.
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
            </motion.div>
          ))}
        </motion.div>
      )}
    </>
  )
}
