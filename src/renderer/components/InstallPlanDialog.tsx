import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { DestinationClass, PlannedFile } from '@shared/types'
import { DESTINATION_LABELS } from '@shared/types'
import { api, formatBytes } from '../api'
import { useApp } from '../state/store'
import { Badge, Button, Disclosure, Modal } from './ui'
import { Icon } from './icons'
import { itemVariants, listVariants, snappy } from '../lib/motion'

const DESTINATIONS = Object.keys(DESTINATION_LABELS) as DestinationClass[]

/**
 * The plan dialog is the product: it shows what the readme said, what Modão
 * decided, which files land where, and what will be displaced - all before a
 * single byte is written.
 */
export function InstallPlanDialog(props: { onDone: () => void }): JSX.Element | null {
  const plan = useApp((s) => s.plan)
  const setPlan = useApp((s) => s.setPlan)
  const busy = useApp((s) => s.planBusy)
  const setBusy = useApp((s) => s.setPlanBusy)
  const profile = useApp((s) => s.profile)
  const pushToast = useApp((s) => s.pushToast)
  const [showReadme, setShowReadme] = useState(false)
  const [showFiles, setShowFiles] = useState(false)

  const grouped = useMemo(() => {
    const map = new Map<DestinationClass, PlannedFile[]>()
    for (const f of plan?.files ?? []) {
      const list = map.get(f.destination) ?? []
      list.push(f)
      map.set(f.destination, list)
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [plan])

  if (!plan) return null

  const blockers = plan.warnings.filter((w) => w.severity === 'error')
  const overwrites = plan.files.filter((f) => f.overwrites)
  const canApply = !plan.requiresVariantChoice && blockers.length === 0 && plan.files.length > 0 && !!profile

  async function choose(groupId: string, optionId: string): Promise<void> {
    setBusy(true)
    try {
      setPlan(await api.choose(plan!.planId, groupId, optionId))
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function retarget(sourcePath: string, destination: string): Promise<void> {
    setBusy(true)
    try {
      setPlan(await api.setDestination(plan!.planId, sourcePath, destination))
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function apply(): Promise<void> {
    if (!profile) return
    setBusy(true)
    try {
      await api.applyPlan(plan!.planId, profile.id)
      setPlan(null)
      props.onDone()
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function discard(): Promise<void> {
    await api.discardPlan(plan!.planId).catch(() => undefined)
    setPlan(null)
  }

  return (
    <Modal
      title={plan.title}
      subtitle={
        <>
          {plan.author}
          {plan.sourceUrl ? (
            <>
              {' · '}
              <a
                href={plan.sourceUrl}
                onClick={(e) => {
                  e.preventDefault()
                  void api.openExternal(plan.sourceUrl!)
                }}
              >
                source page
              </a>
            </>
          ) : null}
          {' · '}
          {plan.files.length} file(s), {formatBytes(plan.totalSize)}
          {overwrites.length ? ` · ${overwrites.length} would be displaced` : ''}
        </>
      }
      onClose={discard}
      footer={
        <>
          <Button onClick={discard} disabled={busy}>
            Cancel
          </Button>
          {plan.readmes.length > 0 ? (
            <Button variant="quiet" onClick={() => setShowReadme((v) => !v)} icon={<Icon.doc width={13} height={13} />}>
              {showReadme ? 'Hide raw readme' : 'Raw readme'}
            </Button>
          ) : null}
          <span className="spacer" />
          <span className="faint">
            {plan.requiresVariantChoice
              ? 'Pick a variant to continue'
              : blockers.length
                ? blockers[0].message
                : 'Nothing is written until you confirm'}
          </span>
          <Button variant="primary" disabled={!canApply || busy} onClick={apply}>
            {busy ? 'Working…' : `Install ${plan.files.length} file(s)`}
          </Button>
        </>
      }
    >
      <motion.div variants={listVariants} initial="initial" animate="animate" className="col" style={{ gap: 12 }}>
        {plan.warnings.length > 0 ? (
          <motion.div variants={itemVariants} className="col" style={{ gap: 8 }}>
            {plan.warnings.map((w, i) => (
              <div key={i} className="notice" data-kind={w.severity === 'info' ? undefined : w.severity}>
                <span className="notice-mark" />
                <div>
                  <strong>{w.message}</strong>
                  {w.detail ? <div className="faint">{w.detail}</div> : null}
                </div>
              </div>
            ))}
          </motion.div>
        ) : null}

        {plan.variants.map((group) => (
          <motion.section variants={itemVariants} className="panel" key={group.id}>
            <header>
              <Badge tone="accent">{group.kind}</Badge>
              {group.question}
            </header>
            <div className="panel-body col">
              {group.hint ? <div className="faint">Readme says: “{group.hint}”</div> : null}
              {group.options.map((o) => {
                const selected = plan.files.some((f) => f.sourcePath.startsWith(`${o.path}/`))
                return (
                  <button
                    key={o.id}
                    className="choice"
                    data-selected={selected}
                    disabled={busy}
                    onClick={() => void choose(group.id, o.id)}
                  >
                    <span className="radio" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="row" style={{ gap: 7 }}>
                        <strong>{o.label}</strong>
                        {o.recommended ? <Badge tone="ok">recommended</Badge> : null}
                      </span>
                      <span className="faint">
                        {o.fileCount} file(s), {formatBytes(o.size)}
                        {o.note ? ` — ${o.note}` : ''}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </motion.section>
        ))}

        {plan.readmes.length > 0 ? (
          <motion.section variants={itemVariants} className="panel">
            <header>
              <Icon.doc width={14} height={14} />
              Readme
              <Badge>{plan.readmes[0].encoding}</Badge>
              <Badge>{plan.readmes[0].language}</Badge>
              <span className="spacer" />
              <span className="faint" style={{ fontWeight: 400 }}>
                {plan.readmes[0].instructions.length} instruction(s) parsed
              </span>
            </header>
            <div className="panel-body col">
              {plan.readmes[0].instructions.length === 0 ? (
                <p className="faint" style={{ margin: 0 }}>
                  No install instruction line was recognised. The plan below comes from inspecting the archive itself.
                </p>
              ) : (
                plan.readmes[0].instructions.map((ins, idx) => (
                  <div key={idx} className="row top" style={{ gap: 9 }}>
                    <Badge tone="accent">{DESTINATION_LABELS[ins.destination]}</Badge>
                    <div style={{ minWidth: 0 }}>
                      <div className="mono">“{ins.line}”</div>
                      {ins.folder ? <div className="faint">Folder named in the readme: {ins.folder}</div> : null}
                    </div>
                  </div>
                ))
              )}
              {plan.readmes[0].requirementUrls.length > 0 ? (
                <div className="faint row wrap" style={{ gap: 8 }}>
                  Links in the readme:
                  {plan.readmes[0].requirementUrls.map((u) => (
                    <a
                      key={u}
                      href={u}
                      onClick={(e) => {
                        e.preventDefault()
                        void api.openExternal(u)
                      }}
                    >
                      {new URL(u).hostname}
                    </a>
                  ))}
                </div>
              ) : null}
              <Disclosure open={showReadme}>
                <pre className="pre" style={{ marginTop: 10 }}>
                  {plan.readmes[0].raw}
                </pre>
              </Disclosure>
            </div>
          </motion.section>
        ) : null}

        {plan.dependencies.length > 0 ? (
          <motion.section variants={itemVariants} className="panel">
            <header>
              <Icon.bolt width={14} height={14} />
              Dependency plan
            </header>
            <div className="panel-body col">
              {plan.dependencies.map((d, i) => (
                <div key={i} className="row top" style={{ gap: 9 }}>
                  <Badge tone={d.resolution === 'blocking' ? 'danger' : d.satisfied ? 'ok' : 'warn'}>
                    {d.kind === 'conflicts' ? 'must not coexist' : d.kind === 'alt' ? 'one of' : 'requires'}
                  </Badge>
                  <div style={{ minWidth: 0 }}>
                    <strong>{d.title}</strong>
                    {d.versionRange ? <span className="faint"> {d.versionRange}</span> : null}
                    {d.alternatives ? (
                      <div className="faint">
                        {d.alternatives.map((a) => `${a.title}${a.satisfied ? ' (installed)' : ''}`).join('  or  ')}
                      </div>
                    ) : null}
                    {d.note ? <div className="faint">{d.note}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          </motion.section>
        ) : null}

        <motion.section variants={itemVariants} className="panel">
          <header>
            <Icon.folder width={14} height={14} />
            File placement
            <span className="faint" style={{ fontWeight: 400 }}>
              every path is relative to the game folder
            </span>
            <span className="spacer" />
            <Button size="sm" variant="quiet" onClick={() => setShowFiles((v) => !v)}>
              {showFiles ? 'Collapse' : 'Show every file'}
            </Button>
          </header>
          <div className="panel-body col" style={{ gap: 7 }}>
            {grouped.map(([dest, files]) => (
              <div key={dest} className="row between">
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  <Badge tone={dest === 'overlay' ? 'warn' : 'accent'}>{DESTINATION_LABELS[dest]}</Badge>
                  <span className="mono ellipsis">{commonPrefix(files)}</span>
                </span>
                <span className="faint num">
                  {files.length} file(s) · {formatBytes(files.reduce((a, f) => a + f.size, 0))}
                </span>
              </div>
            ))}
          </div>
          <AnimatePresence initial={false}>
            {showFiles ? (
              <motion.div
                className="filelist"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={snappy}
              >
                {plan.files.map((f) => (
                  <div className="fileline" key={f.sourcePath}>
                    <span className="ellipsis" title={`${f.sourcePath} → ${f.targetRelative}`}>
                      {f.targetRelative}
                      {f.overwrites ? (
                        <Badge tone="warn">{f.overwritesMod ? `replaces ${f.overwritesMod}` : 'overwrites'}</Badge>
                      ) : null}
                    </span>
                    <span className="faint num">{formatBytes(f.size)}</span>
                    <select
                      className="select"
                      value={f.destination}
                      disabled={busy}
                      onChange={(e) => void retarget(f.sourcePath, e.target.value)}
                    >
                      {DESTINATIONS.map((d) => (
                        <option key={d} value={d}>
                          {DESTINATION_LABELS[d]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.section>
      </motion.div>
    </Modal>
  )
}

function commonPrefix(files: PlannedFile[]): string {
  if (files.length === 0) return ''
  let prefix = files[0].targetRelative.split('/').slice(0, -1).join('/')
  for (const f of files) {
    while (prefix && !f.targetRelative.startsWith(`${prefix}/`)) {
      prefix = prefix.split('/').slice(0, -1).join('/')
    }
  }
  return prefix ? `${prefix}/` : '<game root>'
}
