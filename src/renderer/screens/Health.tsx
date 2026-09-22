import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { BisectSession, CrashIncident, CrashReport, HealthCheck } from '@shared/types'
import { UNLOADED_NOTE } from '@shared/crash'
import { api, relativeTime } from '../api'
import { useT } from '../lib/i18n'
import { useApp } from '../state/store'
import { Badge, Button, Checkbox, Empty, ErrorNote, Loading, Modal, StatusDot, Tabs, useAsync } from '../components/ui'
import { Icon } from '../components/icons'
import { itemVariants, listVariants, smooth, snappy } from '../lib/motion'
import art from '../assets/empty-crashes-320.png'

type Tab = 'check' | 'crashes' | 'bisect' | 'logs'
type ToastFn = (kind: 'info' | 'error' | 'success', message: string) => void

const TAB_IDS: Tab[] = ['check', 'crashes', 'bisect', 'logs']

const STATUS_TONE: Record<HealthCheck['status'], 'ok' | 'warn' | 'danger' | 'neutral'> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'danger',
  skip: 'neutral'
}

export function HealthScreen(): JSX.Element {
  const t = useT()
  const { profile, pushToast } = useApp()
  const [tab, setTab] = useState<Tab>('check')

  if (!profile) {
    return (
      <Empty
        title={t('health.noProfile')}
        hint={t('health.noProfileHint')}
      />
    )
  }

  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        options={TAB_IDS.map((id) => ({ id, label: t(`health.tab${id[0].toUpperCase()}${id.slice(1)}`) }))}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={smooth}
        >
          {tab === 'check' ? <PreLaunch profileId={profile.id} /> : null}
          {tab === 'crashes' ? <Crashes profileId={profile.id} pushToast={pushToast} /> : null}
          {tab === 'bisect' ? <Bisect profileId={profile.id} pushToast={pushToast} /> : null}
          {tab === 'logs' ? <Logs profileId={profile.id} /> : null}
        </motion.div>
      </AnimatePresence>
    </>
  )
}

// ───────────────────────────── pre-launch ─────────────────────────────

function PreLaunch(props: { profileId: number }): JSX.Element {
  const t = useT()
  const report = useAsync(() => api.health(props.profileId), [props.profileId])

  if (report.error) return <ErrorNote message={report.error} onRetry={report.reload} />
  if (report.loading || !report.data) return <Loading label={t('health.running')} />

  const r = report.data
  const passed = r.checks.filter((c) => c.status === 'pass').length
  const warned = r.checks.filter((c) => c.status === 'warn').length
  const failed = r.checks.filter((c) => c.status === 'fail').length
  const skipped = r.checks.filter((c) => c.status === 'skip').length

  const verdict = r.ok
    ? warned > 0
      ? t('health.verdictWarned', { count: warned })
      : t('health.verdictClean')
    : t('health.verdictBlocked', { count: r.blocking, warnings: r.warnings })

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <Badge tone={r.ok ? 'ok' : 'danger'} dot>
            {r.ok ? t('health.readyToLaunch') : t('health.blockingCount', { count: r.blocking })}
          </Badge>
          <Badge tone="ok">{t('health.passCount', { count: passed })}</Badge>
          <Badge tone={warned > 0 ? 'warn' : 'neutral'}>{t('health.warnCount', { count: warned })}</Badge>
          <Badge tone={failed > 0 ? 'danger' : 'neutral'}>{t('health.failCount', { count: failed })}</Badge>
          {skipped > 0 ? <Badge>{t('health.skippedCount', { count: skipped })}</Badge> : null}
          <span className="spacer" />
          <Button size="sm" onClick={report.reload} icon={<Icon.refresh width={13} height={13} />}>
            {t('health.rerun')}
          </Button>
        </div>
        <div className="card-body" style={{ paddingTop: 12, paddingBottom: 12 }}>
          <p style={{ margin: 0 }} className="muted">
            {verdict}
          </p>
          <div className="row wrap faint" style={{ marginTop: 7 }}>
            <span className="mono ellipsis" title={r.gamePath}>
              {r.gamePath}
            </span>
            <span>·</span>
            <span>{t('health.checkedAt', { when: relativeTime(r.generatedAt, t) })}</span>
          </div>
        </div>
      </div>

      <motion.div className="card" variants={listVariants} initial="initial" animate="animate">
        {r.checks.map((c) => (
          <motion.div className="check-row" key={c.id} variants={itemVariants}>
            <StatusDot status={c.status} />
            <div className="col" style={{ gap: 4 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <strong>{c.title}</strong>
                <Badge tone={STATUS_TONE[c.status]}>{t(`health.status.${c.status}`)}</Badge>
              </div>
              <div className="muted">{c.summary}</div>
              {c.detail ? <div className="faint">{c.detail}</div> : null}
              {c.items && c.items.length > 0 ? (
                <ul>
                  {c.items.map((i, idx) => (
                    <li key={idx} className="mono">
                      {i}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </motion.div>
        ))}
      </motion.div>
    </>
  )
}

// ───────────────────────────── crashes ─────────────────────────────

function Crashes(props: { profileId: number; pushToast: ToastFn }): JSX.Element {
  const t = useT()
  const crashes = useAsync(() => api.crashIncidents(props.profileId), [props.profileId])
  const [scanning, setScanning] = useState(false)
  const [detail, setDetail] = useState<CrashIncident | null>(null)
  const [manual, setManual] = useState('')
  const [manualResult, setManualResult] = useState<{ address: string; cause: string | null; solution: string | null } | null>(
    null
  )

  async function scan(): Promise<void> {
    setScanning(true)
    try {
      const r = await api.scanCrashes(props.profileId)
      props.pushToast(r.found ? 'success' : 'info', r.message)
      crashes.reload()
    } catch (e) {
      props.pushToast('error', (e as Error).message)
    } finally {
      setScanning(false)
    }
  }

  async function lookup(): Promise<void> {
    try {
      setManualResult(await api.lookupAddress(manual.trim()))
    } catch (e) {
      props.pushToast('error', (e as Error).message)
    }
  }

  const rows = crashes.data ?? []

  return (
    <>
      <div className="page-head">
        <p>{t('health.crashIntro')}</p>
      </div>

      <div className="row wrap" style={{ marginBottom: 14 }}>
        <Button variant="primary" disabled={scanning} onClick={() => void scan()} icon={<Icon.refresh width={13} height={13} />}>
          {scanning ? t('crashes.scanning') : t('crashes.scan')}
        </Button>
        <span className="spacer" />
        <input
          className="input"
          style={{ width: 230 }}
          placeholder={t('health.lookupPlaceholder')}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && manual.trim() && void lookup()}
        />
        <Button onClick={() => void lookup()} disabled={!manual.trim()} icon={<Icon.search width={13} height={13} />}>
          {t('health.lookup')}
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {manualResult ? (
          <motion.div
            key={manualResult.address}
            className="card pad col"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={snappy}
            style={{ marginBottom: 14, gap: 6 }}
          >
            <div className="row between">
              <strong className="mono">{manualResult.address}</strong>
              <Button size="sm" variant="quiet" iconOnly aria-label={t('shell.dismiss')} onClick={() => setManualResult(null)} icon={<Icon.close />} />
            </div>
            <div>{manualResult.cause ?? t('health.notInList')}</div>
            {manualResult.solution ? <div className="faint">{manualResult.solution}</div> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {crashes.error ? (
        <ErrorNote message={crashes.error} onRetry={crashes.reload} />
      ) : crashes.loading ? (
        <Loading label={t('health.readingCrashes')} />
      ) : rows.length === 0 ? (
        <Empty
          title={t('crashes.none')}
          hint={t('health.noCrashesHint')}
          art={art}
          action={
            <Button size="sm" disabled={scanning} onClick={() => void scan()}>
              {t('health.scanEventLog')}
            </Button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('crashes.when')}</th>
                <th>{t('crashes.kind')}</th>
                <th>{t('crashes.module')}</th>
                <th>{t('crashes.address')}</th>
                <th>{t('crashes.matchedCause')}</th>
                <th style={{ width: 140 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((incident) => {
                const c = incident.primary
                return (
                  <tr key={incident.key} className={c.resolved ? 'off' : ''}>
                    <td className="faint">{relativeTime(incident.occurredAt, t)}</td>
                    <td>
                      <Badge tone={c.kind === 'hang' ? 'warn' : 'danger'}>{c.kind}</Badge>
                      {incident.related.length ? (
                        <span className="faint" style={{ marginLeft: 6 }}>
                          +{incident.related.length}
                        </span>
                      ) : null}
                    </td>
                    <td className="mono ellipsis">
                      {c.module}
                      {c.moduleUnloaded ? (
                        <span style={{ marginLeft: 6 }}>
                          <Badge tone="warn" title={t('crashes.unloadedTitle')}>
                            {t('crashes.unloaded')}
                          </Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className="mono num">{c.crashAddress || '—'}</td>
                    <td>
                      {c.addressKind === 'module' ? (
                        <span className="faint">{t('crashes.notLookedUp')}</span>
                      ) : (
                        c.matchedCause ?? <span className="faint">{t('crashes.notInList')}</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" variant="quiet" onClick={() => setDetail(incident)} icon={<Icon.doc width={13} height={13} />}>
                          {t('app.details')}
                        </Button>
                        <Button
                          size="sm"
                          variant="quiet"
                          onClick={async () => {
                            try {
                              await api.resolveCrash(c.id, !c.resolved)
                              crashes.reload()
                            } catch (e) {
                              props.pushToast('error', (e as Error).message)
                            }
                          }}
                        >
                          {c.resolved ? t('health.reopen') : t('health.resolve')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <AnimatePresence>
        {detail ? (
          <Modal
            title={t('health.crashAt', { address: detail.primary.crashAddress || t('health.unknownAddress') })}
            subtitle={
              detail.primary.kind === 'hang'
                ? t('crashes.hang')
                : detail.related.length
                  ? t('crashes.oneRun', { count: detail.related.length + 1 })
                  : t('crashes.exception')
            }
            onClose={() => setDetail(null)}
            width={780}
          >
            <dl className="kv">
              <dt>{t('crashes.occurred')}</dt>
              <dd>{new Date(detail.primary.occurredAt).toLocaleString()}</dd>
              <dt>{t('crashes.kind')}</dt>
              <dd>{detail.primary.kind === 'hang' ? t('crashes.hang') : t('crashes.exception')}</dd>
              <dt>{t('crashes.module')}</dt>
              <dd className="mono">
                {detail.primary.moduleRaw || detail.primary.module}
                {detail.primary.moduleUnloaded ? ' — already unloaded' : ''}
              </dd>
              <dt>{t('crashes.process')}</dt>
              <dd className="mono">{detail.primary.processId || '—'}</dd>
              <dt>{t('crashes.exceptionCode')}</dt>
              <dd className="mono">{detail.primary.exceptionCode || '—'}</dd>
              <dt>{t('crashes.faultOffset')}</dt>
              <dd className="mono">{detail.primary.faultOffset || '—'}</dd>
              <dt>{detail.primary.addressKind === 'exe' ? t('crashes.crashAddress') : t('crashes.faultLocation')}</dt>
              <dd className="mono">
                {detail.primary.crashAddress || '—'}
                {detail.primary.addressKind === 'exe' ? ' (0x400000 + fault offset)' : ''}
              </dd>
            </dl>

            {detail.primary.moduleUnloaded ? (
              <p className="muted">{UNLOADED_NOTE}</p>
            ) : null}

            <hr className="divider" />
            {detail.primary.addressKind === 'exe' ? (
              <>
                <h3>{t('health.matchedCause')}</h3>
                <p className="muted">{detail.primary.matchedCause ?? t('health.notInCrashList')}</p>
                {detail.primary.matchedSolution ? (
                  <>
                    <h3>{t('health.suggestedFix')}</h3>
                    <p className="muted">{detail.primary.matchedSolution}</p>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <h3>{t('crashes.notLookedUpTitle')}</h3>
                <p className="muted">{detail.primary.addressNote}</p>
              </>
            )}

            {detail.related.length ? (
              <>
                <hr className="divider" />
                <h3>{t('crashes.otherRecords')}</h3>
                <ul className="list">
                  {detail.related.map((r) => (
                    <li key={r.id}>
                      <span className="mono">{r.moduleRaw || r.module}</span>{' '}
                      <span className="mono faint">{r.crashAddress || r.faultOffset}</span>{' '}
                      <span className="faint">{new Date(r.occurredAt).toLocaleTimeString()}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <h3>{t('crashes.rawEvent')}</h3>
            <pre className="pre">{detail.primary.raw}</pre>
          </Modal>
        ) : null}
      </AnimatePresence>
    </>
  )
}

// ───────────────────────────── bisect ─────────────────────────────

function Bisect(props: { profileId: number; pushToast: ToastFn }): JSX.Element {
  const t = useT()
  const [session, setSession] = useState<BisectSession | null>(null)
  const [busy, setBusy] = useState(false)
  const current = useAsync(() => api.bisectCurrent(props.profileId), [props.profileId])
  const active = session ?? current.data

  async function run(fn: () => Promise<BisectSession>): Promise<void> {
    setBusy(true)
    try {
      setSession(await fn())
    } catch (e) {
      props.pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (current.error) return <ErrorNote message={current.error} onRetry={current.reload} />
  if (current.loading) return <Loading label={t('health.lookingForBisect')} />

  return (
    <>
      <div className="page-head">
        <p>
          Halve the enabled mod set, launch, record the result, repeat. Modão keeps the bookkeeping: which half was
          tested, what is cleared and what is still suspect. Aborting restores every mod it disabled, exactly as it
          found them.
        </p>
      </div>

      {!active || active.status !== 'running' ? (
        <div className="card pad col">
          <strong>{t('health.bisectNone')}</strong>
          <span className="muted">
            {t('health.bisectIntro')}
          </span>
          <div>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(() => api.bisectStart(props.profileId))}
              icon={<Icon.bolt width={13} height={13} />}
            >
              {busy ? t('health.bisectPreparing') : t('health.bisectStart')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <Badge tone="accent" dot>
              {t('health.bisectStep', { step: active.step })}
            </Badge>
            <span className="muted">
              {active.testing.length} mod{active.testing.length === 1 ? '' : 's'} enabled for this run,{' '}
              {active.candidates.length} still suspect
            </span>
            <span className="spacer" />
            <Badge tone="ok">{active.knownGood.length} cleared</Badge>
            <Badge tone="danger">{active.knownBad.length} implicated</Badge>
          </div>

          <div className="card-body col">
            <motion.div className="col" variants={listVariants} initial="initial" animate="animate" style={{ gap: 12 }}>
              {active.history.map((h) => (
                <motion.div className="step" data-done="true" key={h.step} variants={itemVariants}>
                  <span className="step-num num">{h.step}</span>
                  <div className="col" style={{ gap: 2 }}>
                    <span>
                      {h.tested.length} mod{h.tested.length === 1 ? '' : 's'} tested
                    </span>
                    <span className="faint">
                      {h.result === 'good' ? 'ran fine — that half is cleared' : 'still failed — the culprit is in that half'}
                    </span>
                  </div>
                </motion.div>
              ))}
              <motion.div className="step" data-done="false" variants={itemVariants}>
                <span className="step-num num">{active.step}</span>
                <div className="col" style={{ gap: 2 }}>
                  <strong>{t('health.bisectLaunchNow')}</strong>
                  <span className="faint">
                    {active.testing.length} mod{active.testing.length === 1 ? '' : 's'} are enabled for this run.
                  </span>
                </div>
              </motion.div>
            </motion.div>

            <div className="row wrap">
              <Button
                disabled={busy}
                onClick={() => void run(() => api.bisectResult(active.id, 'good'))}
                icon={<Icon.check width={13} height={13} />}
              >
                {t('health.bisectItRanFine')}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void run(() => api.bisectResult(active.id, 'bad'))}
                icon={<Icon.warn width={13} height={13} />}
              >
                It still fails
              </Button>
              <span className="spacer" />
              <Button
                variant="quiet"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await api.bisectAbort(active.id)
                    setSession(null)
                    current.reload()
                  } catch (e) {
                    props.pushToast('error', (e as Error).message)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Abort and restore everything
              </Button>
            </div>
          </div>
        </div>
      )}

      {active?.status === 'converged' ? (
        <div className="card pad col" style={{ marginTop: 14, gap: 5 }}>
          <div className="row">
            <Badge tone="ok" dot>
              Converged
            </Badge>
            <span className="tiny-caps">after {active.history.length} steps</span>
          </div>
          <span className="muted">
            {active.culprit
              ? `Install #${active.culprit} is the culprit.`
              : t('health.bisectNoSingleMod')}
          </span>
        </div>
      ) : null}
    </>
  )
}

// ───────────────────────────── logs ─────────────────────────────

function Logs(props: { profileId: number }): JSX.Element {
  const t = useT()
  const logs = useAsync(() => api.logs(props.profileId), [props.profileId])
  const [onlyProblems, setOnlyProblems] = useState(false)
  const entries = (logs.data ?? []).filter((l) => !onlyProblems || l.level !== 'info')

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 7 }}>
          <Checkbox on={onlyProblems} onChange={setOnlyProblems} label={t('health.onlyProblems')} />
          <span style={{ cursor: 'pointer' }} onClick={() => setOnlyProblems(!onlyProblems)}>
            Warnings and errors only
          </span>
        </div>
        <span className="spacer" />
        <span className="faint num">
          {entries.length} line{entries.length === 1 ? '' : 's'}
        </span>
        <Button size="sm" onClick={logs.reload} icon={<Icon.refresh width={13} height={13} />}>
          Refresh
        </Button>
      </div>

      {logs.error ? (
        <ErrorNote message={logs.error} onRetry={logs.reload} />
      ) : logs.loading ? (
        <Loading label={t('health.collectingLogs')} />
      ) : entries.length === 0 ? (
        <Empty
          title={onlyProblems ? t('health.noWarnings') : t('health.noLogs')}
          hint={
            onlyProblems
              ? t('health.logsAllInfo')
              : 'Mod Loader writes modloader.log next to the game once it has run at least once.'
          }
          action={
            onlyProblems ? (
              <Button size="sm" onClick={() => setOnlyProblems(false)}>
                Show every line
              </Button>
            ) : null
          }
        />
      ) : (
        <motion.div
          className="card pad"
          variants={listVariants}
          initial="initial"
          animate="animate"
          // A log can be hundreds of lines: keep the stagger readable, not a countdown.
          transition={{ staggerChildren: 0.004, delayChildren: 0.02 }}
          style={{ maxHeight: '64vh', overflow: 'auto' }}
        >
          {entries.map((l, i) => (
            <motion.div className="log-line" data-level={l.level} key={i} variants={itemVariants}>
              <span className="faint num">{l.timestamp ?? ''}</span>
              <span className="faint ellipsis" title={l.source}>
                {l.source}
              </span>
              <span>{l.message}</span>
            </motion.div>
          ))}
        </motion.div>
      )}
    </>
  )
}
