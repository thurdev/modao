import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { DestinationClass, PlannedFile } from '@shared/types'
import { DESTINATION_KEYS, DESTINATION_LABELS } from '@shared/types'
import { api, formatBytes } from '../api'
import { useApp } from '../state/store'
import { useT } from '../lib/i18n'
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
  const t = useT()
  const plan = useApp((s) => s.plan)
  const setPlan = useApp((s) => s.setPlan)
  const busy = useApp((s) => s.planBusy)
  const setBusy = useApp((s) => s.setPlanBusy)
  const profile = useApp((s) => s.profile)
  const pushToast = useApp((s) => s.pushToast)
  const [showReadme, setShowReadme] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  // An archive whose readme could not be parsed is never installed on a shrug:
  // the user has to say, explicitly, that they read it and want to go ahead.
  const [readmeAck, setReadmeAck] = useState(false)

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
  const unparsedReadme = plan.warnings.some((w) => w.code === 'readme-unparsed')
  const needsReadmeAck = unparsedReadme && !readmeAck
  // pt-BR and en readmes state the same code twice; it is one code.
  const activationCodes = [
    ...new Map(plan.readmes.flatMap((r) => r.activationCodes).map((a) => [a.code.toUpperCase(), a])).values()
  ]
  const canApply =
    !plan.requiresVariantChoice && blockers.length === 0 && plan.files.length > 0 && !!profile && !needsReadmeAck

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

  async function chooseAddOn(addOnId: string, enabled: boolean): Promise<void> {
    setBusy(true)
    try {
      setPlan(await api.chooseAddOn(plan!.planId, addOnId, enabled))
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
                {t('install.plan.sourcePage')}
              </a>
            </>
          ) : null}
          {' · '}
          {t('install.plan.fileCountSize', { count: plan.files.length, size: formatBytes(plan.totalSize) })}
          {overwrites.length ? t('install.plan.displaced', { count: overwrites.length }) : ''}
        </>
      }
      onClose={discard}
      footer={
        <>
          <Button onClick={discard} disabled={busy}>
            {t('app.cancel')}
          </Button>
          {plan.readmes.length > 0 ? (
            <Button variant="quiet" onClick={() => setShowReadme((v) => !v)} icon={<Icon.doc width={13} height={13} />}>
              {showReadme ? t('install.plan.hideReadme') : t('install.plan.rawReadme')}
            </Button>
          ) : null}
          <span className="spacer" />
          <span className="faint">
            {plan.requiresVariantChoice
              ? t('install.plan.pickVariant')
              : blockers.length
                ? blockers[0].message
                : needsReadmeAck
                  ? t('install.plan.confirmUnparsedReadmeFirst')
                  : t('install.plan.nothingWritten')}
          </span>
          <Button variant="primary" disabled={!canApply || busy} onClick={apply}>
            {busy ? t('install.plan.working') : t('install.plan.installButton', { count: plan.files.length })}
          </Button>
        </>
      }
    >
      <motion.div variants={listVariants} initial="initial" animate="animate" className="col" style={{ gap: 12 }}>
        {plan.missingRequirements.length > 0 ? (
          <motion.section variants={itemVariants} className="panel">
            <header>
              <Badge tone="warn">{t('install.planReqs.requirementsTitle')}</Badge>
              {t('install.planReqs.requirementsHint')}
            </header>
            <div className="panel-body col" style={{ gap: 8 }}>
              {plan.missingRequirements.map((req) => (
                <div key={req.name} className="row wrap" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <div className="col" style={{ gap: 2, flex: 1, minWidth: 220 }}>
                    <strong>{req.name}</strong>
                    <span className="faint">{req.evidence}</span>
                  </div>
                  {req.catalogSlug ? (
                    <Button
                      size="sm"
                      variant="accent"
                      icon={<Icon.download width={13} height={13} />}
                      onClick={async () => {
                        const profile = useApp.getState().profile
                        if (!profile) return
                        try {
                          setPlan(await api.planFromSlug(req.catalogSlug as string, profile.id))
                        } catch (err) {
                          pushToast('error', (err as Error).message)
                        }
                      }}
                    >
                      {t('install.planReqs.installRequirement')}
                    </Button>
                  ) : req.url ? (
                    <Button
                      size="sm"
                      icon={<Icon.external width={13} height={13} />}
                      onClick={() => void api.openExternal(normaliseUrl(req.url as string))}
                    >
                      {t('install.planReqs.openRequirement')}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </motion.section>
        ) : null}

        {plan.warnings.length > 0 ? (
          <motion.div variants={itemVariants} className="col" style={{ gap: 8 }}>
            {plan.warnings.map((w, i) => (
              <div key={i} className="notice" data-kind={w.severity === 'info' ? undefined : w.severity}>
                <span className="notice-mark" />
                <div>
                  <strong>{w.message}</strong>
                  {w.detail ? <div className="faint">{w.detail}</div> : null}
                  {w.code === 'readme-unparsed' ? (
                    <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                      <label className="choice" data-selected={readmeAck} style={{ flex: 1, minWidth: 240 }}>
                        <input
                          type="checkbox"
                          checked={readmeAck}
                          onChange={(e) => setReadmeAck(e.target.checked)}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>{t('install.plan.confirmUnparsedReadme')}</span>
                      </label>
                      <Button
                        size="sm"
                        variant="quiet"
                        icon={<Icon.doc width={13} height={13} />}
                        onClick={() => setShowReadme((v) => !v)}
                      >
                        {showReadme ? t('install.plan.hideReadme') : t('install.plan.rawReadme')}
                      </Button>
                    </div>
                  ) : null}
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
              {group.hint ? <div className="faint">{t('install.plan.readmeSays', { hint: group.hint })}</div> : null}
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
                        {o.recommended ? <Badge tone="ok">{t('install.plan.recommended')}</Badge> : null}
                      </span>
                      <span className="faint">
                        {t('install.plan.fileCountSize', { count: o.fileCount, size: formatBytes(o.size) })}
                        {o.note ? ` — ${o.note}` : ''}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </motion.section>
        ))}

        {plan.addOns.length > 0 ? (
          <motion.section variants={itemVariants} className="panel">
            <header>
              <Badge>{t('install.plan.addOnsTitle')}</Badge>
              <span className="faint" style={{ fontWeight: 400 }}>
                {t('install.plan.addOnsHint')}
              </span>
            </header>
            <div className="panel-body col">
              {plan.addOns.map((a) => {
                const enabled = plan.files.some((f) => f.sourcePath.startsWith(`${a.path}/`))
                return (
                  <label key={a.id} className="choice" data-selected={enabled}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={busy}
                      onChange={(e) => void chooseAddOn(a.id, e.target.checked)}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <strong>{a.label}</strong>
                      <span className="faint">
                        {' '}
                        {t('install.plan.fileCountSize', { count: a.fileCount, size: formatBytes(a.size) })}
                        {enabled ? ` — ${t('install.plan.addOnAsOwnMod')}` : ''}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </motion.section>
        ) : null}

        {plan.readmes.length > 0 ? (
          <motion.section variants={itemVariants} className="panel">
            <header>
              <Icon.doc width={14} height={14} />
              {t('install.plan.readmeHeader')}
              <Badge>{plan.readmes[0].encoding}</Badge>
              <Badge>{plan.readmes[0].language}</Badge>
              <span className="spacer" />
              <span className="faint" style={{ fontWeight: 400 }}>
                {t('install.plan.instructionsParsed', { count: plan.readmes[0].instructions.length })}
              </span>
            </header>
            <div className="panel-body col">
              {plan.readmes[0].instructions.length === 0 ? (
                <p className="faint" style={{ margin: 0 }}>
                  {t('install.plan.noInstructionLine')}
                </p>
              ) : (
                plan.readmes[0].instructions.map((ins, idx) => (
                  <div key={idx} className="row top" style={{ gap: 9 }}>
                    <Badge tone="accent">{t(DESTINATION_KEYS[ins.destination])}</Badge>
                    <div style={{ minWidth: 0 }}>
                      <div className="mono">“{ins.line}”</div>
                      {ins.folder ? <div className="faint">{t('install.plan.folderNamedInReadme', { folder: ins.folder })}</div> : null}
                    </div>
                  </div>
                ))
              )}
              {activationCodes.length > 0 ? (
                <div className="col" style={{ gap: 4 }}>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <Badge tone="ok">{t('install.plan.activationTitle')}</Badge>
                    {activationCodes.map((a) => (
                      <code key={a.code} className="mono">
                        {a.code}
                      </code>
                    ))}
                  </div>
                  <span className="faint">{t('install.plan.activationHint')}</span>
                  {activationCodes.map((a) => (
                    <div key={`${a.code}-line`} className="faint mono">
                      “{a.line}”
                    </div>
                  ))}
                </div>
              ) : null}
              {plan.readmes[0].requirementUrls.length > 0 ? (
                <div className="faint row wrap" style={{ gap: 8 }}>
                  {t('install.plan.linksInReadme')}
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
              {t('install.plan.dependencyPlan')}
            </header>
            <div className="panel-body col">
              {plan.dependencies.map((d, i) => (
                <div key={i} className="row top" style={{ gap: 9 }}>
                  <Badge tone={d.resolution === 'blocking' ? 'danger' : d.satisfied ? 'ok' : 'warn'}>
                    {d.kind === 'conflicts' ? t('install.plan.mustNotCoexist') : d.kind === 'alt' ? t('install.plan.oneOf') : t('install.plan.requires')}
                  </Badge>
                  <div style={{ minWidth: 0 }}>
                    <strong>{d.title}</strong>
                    {d.versionRange ? <span className="faint"> {d.versionRange}</span> : null}
                    {d.alternatives ? (
                      <div className="faint">
                        {d.alternatives
                          .map((a) => `${a.title}${a.satisfied ? t('install.plan.installedSuffix') : ''}`)
                          .join(`  ${t('install.plan.or')}  `)}
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
            {t('install.plan.filePlacement')}
            <span className="faint" style={{ fontWeight: 400 }}>
              {t('install.plan.relativeHint')}
            </span>
            <span className="spacer" />
            <Button size="sm" variant="quiet" onClick={() => setShowFiles((v) => !v)}>
              {showFiles ? t('install.plan.collapse') : t('install.plan.showEveryFile')}
            </Button>
          </header>
          <div className="panel-body col" style={{ gap: 7 }}>
            {grouped.map(([dest, files]) => (
              <div key={dest} className="row between">
                <span className="row" style={{ gap: 8, minWidth: 0 }}>
                  <Badge tone={dest === 'overlay' ? 'warn' : 'accent'}>{t(DESTINATION_KEYS[dest])}</Badge>
                  <span className="mono ellipsis">{commonPrefix(files, t('install.plan.gameRoot'))}</span>
                </span>
                <span className="faint num">
                  {t('install.plan.fileCountSizeDot', {
                    count: files.length,
                    size: formatBytes(files.reduce((a, f) => a + f.size, 0))
                  })}
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
                        <Badge tone="warn">
                          {f.overwritesMod
                            ? t('install.plan.replacesMod', { mod: f.overwritesMod })
                            : t('install.plan.overwritesLabel')}
                        </Badge>
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
                          {t(DESTINATION_KEYS[d])}
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

function commonPrefix(files: PlannedFile[], gameRootLabel: string): string {
  if (files.length === 0) return ''
  let prefix = files[0].targetRelative.split('/').slice(0, -1).join('/')
  for (const f of files) {
    while (prefix && !f.targetRelative.startsWith(`${prefix}/`)) {
      prefix = prefix.split('/').slice(0, -1).join('/')
    }
  }
  return prefix ? `${prefix}/` : gameRootLabel
}

/** Readmes write links without a scheme: "MixMods.com.br/2015/01/...". */
function normaliseUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`
}
