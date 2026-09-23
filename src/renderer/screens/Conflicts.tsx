import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { FileConflict } from '@shared/types'
import { api, formatBytes } from '../api'
import { useApp } from '../state/store'
import { useT } from '../lib/i18n'
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
  const t = useT()
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
      pushToast('success', t('conflicts.writeSuccess'))
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setWriting(false)
    }
  }

  if (!profile) {
    return <Empty title={t('conflicts.noProfileTitle')} hint={t('conflicts.noProfileHint')} />
  }

  return (
    <>
      <div className="page-head">
        <p>{t('conflicts.introPriority')}</p>
        <p>{t('conflicts.introChange')}</p>
      </div>

      <div className="row wrap" style={{ marginBottom: 14 }}>
        <Search value={filter} onChange={setFilter} placeholder={t('conflicts.filterPlaceholder')} width={300} />
        <span className="spacer" />
        <span className="faint num">
          {t('conflicts.pathCount', { count: filtered.length })}
          {filtered.length !== shown.length ? t('conflicts.pathCountOf', { count: shown.length }) : ''}
        </span>
      </div>

      {conflicts.error ? (
        <ErrorNote message={conflicts.error} onRetry={conflicts.reload} />
      ) : conflicts.loading ? (
        <Loading label={t('conflicts.loadingIndex')} />
      ) : filtered.length === 0 ? (
        <Empty
          title={filter ? t('conflicts.nothingMatchesTitle') : t('conflicts.noConflictsTitle')}
          hint={filter ? t('conflicts.nothingMatchesHint') : t('conflicts.noConflictsHint')}
          art={art}
          action={
            filter ? (
              <Button size="sm" onClick={() => setFilter('')}>
                {t('conflicts.clearFilter')}
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
                    {t('conflicts.pendingCount', { count: pending })}
                  </Badge>
                  <span className="muted">{t('conflicts.pendingNote')}</span>
                  <span className="spacer" />
                  <Button size="sm" onClick={discard} disabled={writing}>
                    {t('conflicts.discard')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void commit()}
                    disabled={writing}
                    icon={<Icon.check width={13} height={13} />}
                  >
                    {writing ? t('conflicts.writing') : t('conflicts.writeButton')}
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
                  tone={c.kind === 'modloader' ? 'accent' : 'warn'}
                  title={
                    c.kind === 'physical'
                      ? t('conflicts.kindPhysicalTitle')
                      : c.kind === 'split-model'
                        ? t('conflicts.kindSplitModelTitle')
                        : t('conflicts.kindMergeTitle')
                  }
                >
                  {c.kind === 'physical'
                    ? t('conflicts.kindPhysical')
                    : c.kind === 'split-model'
                      ? t('conflicts.kindSplitModel')
                      : t('conflicts.kindMerge')}
                </Badge>
                <Badge>{t('conflicts.modsCount', { count: c.claimants.length })}</Badge>
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
                          {!claim.enabled ? <Badge>{t('conflicts.disabledBadge')}</Badge> : null}
                          {claim.priority === 0 ? <Badge tone="warn">{t('conflicts.ignoredBadge')}</Badge> : null}
                          {edited ? (
                            <Badge tone="accent" dot>
                              {t('conflicts.editedBadge')}
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
                        {winner ? t('conflicts.wins') : t('conflicts.shadowed')}
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

              {/* A split model has no winner BECAUSE each mod wins one half of it -
                  the opposite of "nothing claims this path", so it gets its own
                  explanation rather than the vanilla-fallback one. */}
              {c.kind === 'split-model' ? (
                <div style={{ padding: '0 13px 10px' }}>
                  <div className="notice" data-kind="warn">
                    <span className="notice-mark" />
                    <div className="col" style={{ gap: 4 }}>
                      <strong>{t('conflicts.splitModelTitle')}</strong>
                      <span className="muted">{t('conflicts.splitModelHint')}</span>
                    </div>
                  </div>
                </div>
              ) : !c.winner ? (
                <div style={{ padding: '0 13px 10px' }}>
                  <div className="notice">
                    <span className="notice-mark" />
                    <div className="col" style={{ gap: 4 }}>
                      <strong>{t('conflicts.noWinnerTitle')}</strong>
                      <span className="muted">{t('conflicts.noWinnerHint')}</span>
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
