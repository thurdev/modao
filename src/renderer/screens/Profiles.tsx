import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Profile, SwitchPlan, SwitchVerification } from '@shared/types'
import { api, formatBytes, relativeTime } from '../api'
import { useApp } from '../state/store'
import { Button, Confirm, Empty, Field, Modal } from '../components/ui'
import { Icon } from '../components/icons'
import { useT } from '../lib/i18n'
import { itemVariants, listVariants } from '../lib/motion'

const COLORS = ['#d8a657', '#8ab0a0', '#b08a8a', '#9a92b5', '#a6a08c', '#7f97b5']

export function ProfilesScreen(): JSX.Element {
  const t = useT()
  const { profiles, refreshProfiles, pushToast, game, orphanSaves, checkOrphanSaves } = useApp()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)
  const [deleting, setDeleting] = useState<Profile | null>(null)
  const [switching, setSwitching] = useState<number | null>(null)
  const [switchLog, setSwitchLog] = useState<{
    name: string
    elapsedMs: number
    log: string[]
    verification: SwitchVerification | null
    journalId: number | null
  } | null>(null)
  const [dryRun, setDryRun] = useState<SwitchPlan | null>(null)
  const [planning, setPlanning] = useState<number | null>(null)
  const [restoring, setRestoring] = useState(false)

  async function switchTo(p: Profile): Promise<void> {
    setSwitching(p.id)
    try {
      const result = await api.activateProfile(p.id)
      await Promise.all([refreshProfiles(), checkOrphanSaves()])
      setSwitchLog({
        name: p.name,
        elapsedMs: result.elapsedMs,
        log: result.log,
        verification: result.verification,
        journalId: result.journalId
      })
    } catch (e) {
      pushToast('error', (e as Error).message)
      // A switch refused because mods cannot be materialised leaves the user
      // stuck on a profile they cannot open. Show them exactly which ones, and
      // offer the way out.
      if (/cannot be materialised|não podem ser materializados/i.test((e as Error).message)) {
        await api
          .switchPlan(p.id)
          .then(setDryRun)
          .catch(() => undefined)
      }
    } finally {
      setSwitching(null)
    }
  }

  /** Removes entries for mods that no longer exist anywhere, so the profile opens again. */
  async function forgetMissing(profileId: number): Promise<void> {
    try {
      const forgotten = await api.forgetMissing(profileId)
      await refreshProfiles()
      setDryRun(await api.switchPlan(profileId))
      if (forgotten.length === 0) pushToast('info', t('profiles.nothingToForget'))
    } catch (e) {
      pushToast('error', (e as Error).message)
    }
  }

  /** The same plan the real switch runs, printed instead of executed. */
  async function previewSwitch(p: Profile): Promise<void> {
    setPlanning(p.id)
    try {
      setDryRun(await api.switchPlan(p.id))
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setPlanning(null)
    }
  }

  async function restorePrevious(): Promise<void> {
    setRestoring(true)
    try {
      const result = await api.restorePreviousSwitch()
      await Promise.all([refreshProfiles(), checkOrphanSaves()])
      setSwitchLog(null)
      pushToast('success', `Restored ${result.restored} file(s) from the pre-switch backup.`)
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="page-head">
        <p>
          {t('profiles.intro')}
        </p>
      </div>

      {game && !game.sameVolumeAsStore ? (
        <div className="notice" data-kind="warn">
          <span className="notice-mark" />
          <div>
            <strong>{t('profiles.differentVolumes')}</strong>
            <div className="faint">
              Junctions still work across volumes, but anything that needs a per-file link falls back to copying. The
              first switch will be slower and will use more disk.
            </div>
          </div>
        </div>
      ) : null}

      {orphanSaves ? (
        <div className="notice" data-kind="warn">
          <span className="notice-mark" />
          <div>
            <strong>{t('profiles.orphanSaves', { count: orphanSaves.slots })}</strong>
            <div className="faint">
              Found in <span className="mono">{orphanSaves.path}</span>. Claim them from the Saves screen before
              switching profiles.
            </div>
          </div>
        </div>
      ) : null}

      <div className="row wrap">
        <Button variant="primary" icon={<Icon.plus width={13} height={13} />} onClick={() => setCreating(true)}>
          {t('profiles.newProfile')}
        </Button>
        <Button
          icon={<Icon.upload width={13} height={13} />}
          onClick={async () => {
            try {
              const result = await api.importProfile()
              if (!result) return
              await refreshProfiles()
              const notes = [
                `${result.resolved} mod(s) restored from the local store`,
                result.needsDownload.length ? `${result.needsDownload.length} still need downloading` : '',
                result.unresolved.length ? `${result.unresolved.length} not in the catalog` : ''
              ].filter(Boolean)
              pushToast(result.needsDownload.length || result.unresolved.length ? 'info' : 'success', `${notes.join(', ')}.`)
            } catch (e) {
              pushToast('error', (e as Error).message)
            }
          }}
        >
          {t('profiles.importProfile')}
        </Button>
        <span className="spacer" />
        <span className="faint num">{t('profiles.profileCount', { count: profiles.length })}</span>
      </div>

      {profiles.length === 0 ? (
        <Empty
          title="No profiles yet"
          hint="Create one, or adopt an existing install from setup."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('profiles.newProfile')}
            </Button>
          }
        />
      ) : (
        <motion.div className="grid cards" variants={listVariants} initial="initial" animate="animate">
          {profiles.map((p) => (
            <motion.article key={p.id} className="profile-card" data-active={p.isActive} variants={itemVariants} layout>
              <div className="row between top">
                <div className="row" style={{ gap: 8, minWidth: 0 }}>
                  <span className="profile-tag" style={{ background: p.color }} />
                  <div style={{ minWidth: 0 }}>
                    <strong className="ellipsis">{p.name}</strong>
                    <div className="faint">
                      {p.isActive ? t('profiles.activeNow') : t('profiles.played', { when: relativeTime(p.lastPlayedAt, t) })}
                    </div>
                  </div>
                </div>
                {p.isActive ? <span className="badge ok">{t('profiles.activeBadge')}</span> : null}
              </div>

              {p.notes ? <div className="faint">{p.notes}</div> : null}

              <div className="profile-stats">
                <span className="stat">
                  <b className="num">
                    {p.enabledCount}
                    <span className="faint num" style={{ fontSize: 11, fontWeight: 400 }}>
                      {' '}
                      / {p.modCount}
                    </span>
                  </b>
                  <span>{t('profiles.modsOn')}</span>
                </span>
                <span className="stat">
                  <b className="num">{formatBytes(p.totalSize)}</b>
                  <span>{t('profiles.tracked')}</span>
                </span>
                <span className="stat">
                  <b className="num">{p.saveCount}</b>
                  <span>{t('profiles.saveSlots')}</span>
                </span>
                <span className="stat">
                  <b className="num">{relativeTime(p.createdAt, t)}</b>
                  <span>{t('profiles.created')}</span>
                </span>
              </div>

              <div className="row wrap" style={{ marginTop: 'auto' }}>
                <Button
                  size="sm"
                  variant={p.isActive ? 'default' : 'primary'}
                  disabled={p.isActive || switching !== null}
                  onClick={() => switchTo(p)}
                >
                  {p.isActive ? t('profiles.active') : switching === p.id ? t('profiles.switching') : t('profiles.switchTo')}
                </Button>
                {p.isActive ? null : (
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={planning !== null || switching !== null}
                    icon={<Icon.doc width={13} height={13} />}
                    onClick={() => void previewSwitch(p)}
                    title={t('profiles.dryRunHint')}
                  >
                    {planning === p.id ? t('profiles.planning') : t('profiles.dryRun')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="quiet"
                  icon={<Icon.copy width={13} height={13} />}
                  onClick={async () => {
                    await api.duplicateProfile(p.id, `${p.name} copy`)
                    await refreshProfiles()
                    pushToast('success', 'Duplicated — payloads stay shared, nothing was copied on disk.')
                  }}
                >
                  {t('profiles.duplicate')}
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  icon={<Icon.download width={13} height={13} />}
                  onClick={async () => {
                    const file = await api.exportProfile(p.id)
                    if (file) pushToast('success', `Manifest written to ${file}`)
                  }}
                >
                  {t('profiles.export')}
                </Button>
                <span className="spacer" />
                <Button size="sm" variant="quiet" iconOnly aria-label="Edit" onClick={() => setEditing(p)} icon={<Icon.settings />} />
                <Button
                  size="sm"
                  variant="quiet"
                  iconOnly
                  aria-label="Delete"
                  disabled={p.isActive}
                  onClick={() => setDeleting(p)}
                  icon={<Icon.trash />}
                />
              </div>
            </motion.article>
          ))}
        </motion.div>
      )}

      <AnimatePresence>
        {creating ? (
          <ProfileEditor
            key="create"
            title={t('profiles.newProfile')}
            initial={{ name: '', color: COLORS[profiles.length % COLORS.length], notes: '' }}
            copyFromOptions={profiles}
            onClose={() => setCreating(false)}
            onSave={async (values) => {
              await api.createProfile(values)
              await refreshProfiles()
              setCreating(false)
            }}
          />
        ) : null}

        {editing ? (
          <ProfileEditor
            key="edit"
            title={`Edit ${editing.name}`}
            initial={{ name: editing.name, color: editing.color, notes: editing.notes }}
            onClose={() => setEditing(null)}
            onSave={async (values) => {
              await api.updateProfile(editing.id, values)
              await refreshProfiles()
              setEditing(null)
            }}
          />
        ) : null}

        {deleting ? (
          <Confirm
            key="delete"
            title={`Delete ${deleting.name}?`}
            danger
            confirmLabel="Delete profile"
            onClose={() => setDeleting(null)}
            onConfirm={async () => {
              try {
                await api.removeProfile(deleting.id)
                await refreshProfiles()
                pushToast('success', 'Profile deleted. Its saves and snapshots moved to quarantine, not erased.')
              } catch (e) {
                pushToast('error', (e as Error).message)
              }
              setDeleting(null)
            }}
            body={
              <>
                <p>
                  The profile and its links are removed. Its save games and snapshots move to the quarantine folder
                  inside Modão&apos;s data directory — nothing is deleted.
                </p>
                <p className="faint">{t('profiles.payloadsStay')}</p>
              </>
            }
          />
        ) : null}

        {switchLog ? (
          <Modal
            key="log"
            title={
              switchLog.verification && !switchLog.verification.ok
                ? t('profiles.switchedButFailed', { name: switchLog.name })
                : t('profiles.switchedTo', { name: switchLog.name })
            }
            subtitle={`${(switchLog.elapsedMs / 1000).toFixed(2)} s`}
            onClose={() => setSwitchLog(null)}
            width={720}
            footer={
              <>
                {switchLog.journalId !== null ? (
                  <Button
                    variant="danger"
                    disabled={restoring}
                    onClick={() => void restorePrevious()}
                    icon={<Icon.undo width={13} height={13} />}
                  >
                    {restoring ? t('profiles.restoring') : t('profiles.restorePrevious')}
                  </Button>
                ) : null}
                <span className="spacer" />
                <Button variant="primary" onClick={() => setSwitchLog(null)}>
                  {t('app.done')}
                </Button>
              </>
            }
          >
            {switchLog.verification ? <VerificationReport v={switchLog.verification} /> : null}
            <h3>{t('profiles.whatHappened')}</h3>
            <pre className="pre">{switchLog.log.join('\n')}</pre>
          </Modal>
        ) : null}

        {dryRun ? (
          <Modal
            key="dry-run"
            title={t('profiles.dryRunTitle', { name: dryRun.toProfileName })}
            subtitle={t('profiles.dryRunSubtitle')}
            onClose={() => setDryRun(null)}
            width={760}
            footer={
              <>
                <span className="spacer" />
                <Button onClick={() => setDryRun(null)}>{t('app.close')}</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    const target = profiles.find((p) => p.id === dryRun.toProfileId)
                    setDryRun(null)
                    if (target) void switchTo(target)
                  }}
                >
                  {t('profiles.runIt')}
                </Button>
              </>
            }
          >
            <DryRunReport plan={dryRun} onForgetMissing={() => void forgetMissing(dryRun.toProfileId)} />
          </Modal>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function ProfileEditor(props: {
  title: string
  initial: { name: string; color: string; notes: string }
  copyFromOptions?: Profile[]
  onClose: () => void
  onSave: (values: { name: string; color: string; notes: string; copyFrom?: number }) => Promise<void>
}): JSX.Element {
  const [name, setName] = useState(props.initial.name)
  const [color, setColor] = useState(props.initial.color)
  const [notes, setNotes] = useState(props.initial.notes)
  const [copyFrom, setCopyFrom] = useState<number | ''>('')
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      width={540}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <span className="spacer" />
          <Button
            variant="primary"
            disabled={!name.trim() || busy}
            onClick={async () => {
              setBusy(true)
              await props.onSave({ name, color, notes, copyFrom: copyFrom === '' ? undefined : Number(copyFrom) })
              setBusy(false)
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="field">
          <label>Colour</label>
          <div className="row wrap" style={{ gap: 6 }}>
            {COLORS.map((c) => (
              <button
                key={c}
                aria-label={c}
                onClick={() => setColor(c)}
                style={{
                  width: 30,
                  height: 24,
                  borderRadius: 6,
                  background: c,
                  cursor: 'pointer',
                  border: color === c ? '2px solid var(--text)' : '1px solid var(--border)'
                }}
              />
            ))}
          </div>
        </div>
        <Field label="Notes" hint="What this profile is for — a run, a graphics setup, a test bed.">
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {props.copyFromOptions?.length ? (
          <Field label="Start from" hint="Copies the mod set and priorities. Payloads stay shared; nothing is duplicated on disk.">
            <select
              className="select"
              value={copyFrom}
              onChange={(e) => setCopyFrom(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">Empty profile</option>
              {props.copyFromOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.modCount} mods)
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
    </Modal>
  )
}

/**
 * What a switch verified, in the terms that matter: did every mod arrive, do the
 * plugin folders hold what they should, does modloader.ini parse and name this
 * profile's mods. A switch is not "done" until this passes.
 */
function VerificationReport(props: { v: SwitchVerification }): JSX.Element {
  const t = useT()
  const v = props.v
  return (
    <div className="col" style={{ gap: 10, marginBottom: 14 }}>
      <div className="notice" data-kind={v.ok ? 'ok' : 'warn'}>
        <span className="notice-mark" />
        <div>
          <strong>{v.ok ? t('profiles.verified') : t('profiles.notVerified')}</strong>
          <div className="faint">
            {t('profiles.verificationSummary', {
              materialised: v.modsMaterialised,
              expected: v.modsExpected,
              asi: v.asiCount,
              cleoPlugins: v.cleoPluginCount,
              cleoScripts: v.cleoScriptCount,
              ini: v.iniParsed ? t('profiles.iniParses') : t('profiles.iniFailed')
            })}
          </div>
        </div>
      </div>
      {v.problems.length ? (
        <ul className="list">
          {v.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {v.missingMods.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('profiles.modDidNotArrive')}</th>
                <th>{t('profiles.why')}</th>
              </tr>
            </thead>
            <tbody>
              {v.missingMods.map((m) => (
                <tr key={m.installId}>
                  <td>{m.label}</td>
                  <td className="faint">{m.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {v.unresolvedDependencies.length ? (
        <div>
          <strong>{t('profiles.unresolvedDeps')}</strong>
          <ul className="list">
            {v.unresolvedDependencies.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function DryRunReport(props: { plan: SwitchPlan; onForgetMissing?: () => void }): JSX.Element {
  const t = useT()
  const plan = props.plan
  return (
    <div className="col" style={{ gap: 12 }}>
      <dl className="kv">
        <dt>{t('profiles.leaving')}</dt>
        <dd>
          {t('profiles.outgoingSummary', { count: plan.outgoing.length, size: formatBytes(plan.totalBytes) })}
        </dd>
        <dt>{t('profiles.arriving')}</dt>
        <dd>{t('profiles.incomingSummary', { count: plan.incoming.length })}</dd>
        <dt>{t('profiles.toStoreFirst')}</dt>
        <dd>
          {plan.toIngest.length
            ? plan.toIngest.map((i) => `${i.label} (${i.files})`).join(', ')
            : t('profiles.nothing')}
        </dd>
        <dt>{t('profiles.untouched')}</dt>
        <dd>{plan.unmanaged.length ? plan.unmanaged.join(', ') : t('profiles.nothing')}</dd>
      </dl>

      {plan.willBeOverwritten.length ? (
        <div className="notice" data-kind="warn">
          <span className="notice-mark" />
          <div>
            <strong>{t('profiles.willBeOverwritten', { count: plan.willBeOverwritten.length })}</strong>
            <ul className="list">
              {plan.willBeOverwritten.map((rel) => (
                <li key={rel}>{rel}</li>
              ))}
            </ul>
            <span className="faint">{t('profiles.willBeOverwrittenHint')}</span>
          </div>
        </div>
      ) : null}

      {plan.unresolved.length ? (
        <div className="notice" data-kind="warn">
          <span className="notice-mark" />
          <div>
            <strong>{t('profiles.wouldRefuse', { count: plan.unresolved.length })}</strong>
            <ul className="list">
              {plan.unresolved.map((u) => (
                <li key={u.installId}>
                  {u.label}: <span className="faint">{u.reason}</span>
                </li>
              ))}
            </ul>
            {props.onForgetMissing ? (
              <span className="row">
                <Button size="sm" variant="danger" onClick={() => void props.onForgetMissing?.()}>
                  {t('profiles.forgetMissing', { count: plan.unresolved.length })}
                </Button>
                <span className="faint">{t('profiles.forgetMissingHint')}</span>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('profiles.file')}</th>
              <th>{t('profiles.whatHappens')}</th>
              <th>{t('profiles.mod')}</th>
            </tr>
          </thead>
          <tbody>
            {[...plan.outgoing, ...plan.incoming].map((f) => (
              <tr key={`${f.action}-${f.relativePath}`}>
                <td className="mono ellipsis">{f.relativePath}</td>
                <td>{t(`profiles.actions.${f.action}`)}</td>
                <td className="faint ellipsis">{f.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
