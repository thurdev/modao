import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ExistingSavesReport, GameInstall } from '@shared/types'
import { api, formatBytes } from '../api'
import { useApp } from '../state/store'
import { Button, Field, Loading, useAsync } from './ui'
import { Icon } from './icons'
import { itemVariants, listVariants, smooth } from '../lib/motion'
import mark from '../assets/mark.png'

/**
 * First run. Three steps, in the order that keeps the user's install safe:
 * find the game, look at what is already there, adopt it without moving a
 * single file - including the save games that predate Modão.
 */
export function Setup(): JSX.Element {
  const { pushToast, refreshGames, refreshProfiles, checkOrphanSaves, setScreen } = useApp()
  const [added, setAdded] = useState<GameInstall | null>(null)
  const [profileName, setProfileName] = useState('My install')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<string[] | null>(null)

  const candidates = useAsync(() => api.detectGames(), [])
  const saves = useAsync<ExistingSavesReport | null>(() => api.detectExistingSaves().catch(() => null), [])

  async function add(pathToAdd: string): Promise<void> {
    setBusy(true)
    try {
      const game = await api.addGame(pathToAdd)
      await api.setActiveGame(game.id)
      setAdded(game)
      await refreshGames()
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function adopt(): Promise<void> {
    if (!added) return
    setBusy(true)
    try {
      const result = await api.adopt(added.id, profileName)
      setReport(result.report)
      await Promise.all([refreshProfiles(), refreshGames(), checkOrphanSaves()])
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="content" style={{ maxWidth: 780, margin: '0 auto', paddingTop: 48 }}>
      <motion.div variants={listVariants} initial="initial" animate="animate" className="col" style={{ gap: 20 }}>
        <motion.div variants={itemVariants} className="row" style={{ gap: 12 }}>
          <img src={mark} alt="" width={40} height={40} style={{ borderRadius: 11 }} />
          <div>
            <h1 style={{ fontSize: 21 }}>Set up Modão</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Your install is treated as the source of truth. Setup indexes what is already there — no file is moved,
              renamed or rewritten, and the priorities already in modloader.ini are read, not replaced.
            </p>
          </div>
        </motion.div>

        {/* step 1 */}
        <motion.section variants={itemVariants} className="card">
          <div className="card-head">
            <span className="step" data-done={!!added} style={{ gridTemplateColumns: '22px' }}>
              <span className="step-num">{added ? <Icon.check width={11} height={11} /> : '1'}</span>
            </span>
            <h3>Find GTA: San Andreas</h3>
          </div>
          <div className="card-body col">
            {added ? (
              <dl className="kv">
                <dt>Folder</dt>
                <dd className="mono">{added.path}</dd>
                <dt>Executable</dt>
                <dd>
                  {added.isV1UsOriginal ? 'v1.0 US, stock' : 'patched or non-stock'} · {added.exeSize.toLocaleString()} bytes ·{' '}
                  {added.largeAddressAware ? 'LARGE_ADDRESS_AWARE set (4 GB)' : 'no LAA flag (2 GB limit)'}
                </dd>
                <dt>Mod Loader</dt>
                <dd>{added.hasModLoader ? (added.modLoaderVersion ?? 'installed') : 'not installed'}</dd>
                <dt>ASI directory</dt>
                <dd className="mono">{added.asiDirectory ?? 'none detected'}</dd>
                <dt>CLEO</dt>
                <dd>{added.cleoVersion ?? 'not installed'}</dd>
                <dt>Write access</dt>
                <dd>
                  {added.access.writable
                    ? `Modão can write to ${added.access.probedPath}`
                    : (added.access.reason ??
                      'Windows denies writes to this folder. Adoption still works - it only reads - but installing or switching profiles will not until this is fixed.')}
                </dd>
                <dt>Mod store</dt>
                <dd>
                  {added.sameVolumeAsStore
                    ? 'Same volume as the game — profiles link instead of copying, so switching costs nothing.'
                    : 'Different volume from the game — Modão will use junctions where it can and copy where it cannot. The first switch will take longer.'}
                </dd>
              </dl>
            ) : (
              <>
                {candidates.loading ? <Loading label="Looking in the usual places…" /> : null}
                {(candidates.data ?? []).map((p) => (
                  <div key={p} className="row between">
                    <span className="mono ellipsis" title={p}>
                      {p}
                    </span>
                    <Button size="sm" disabled={busy} onClick={() => add(p)}>
                      Use this
                    </Button>
                  </div>
                ))}
                {candidates.data && candidates.data.length === 0 ? (
                  <p className="faint" style={{ margin: 0 }}>
                    Nothing found automatically — normal for portable copies and repacks.
                  </p>
                ) : null}
                <div>
                  <Button variant="primary" disabled={busy} icon={<Icon.folder width={13} height={13} />} onClick={async () => {
                    const picked = await api.pickGameFolder()
                    if (picked) await add(picked)
                  }}>
                    Browse for the folder…
                  </Button>
                </div>
              </>
            )}
          </div>
        </motion.section>

        {/* step 2 */}
        <AnimatePresence>
          {added && !report ? (
            <motion.section
              className="card"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={smooth}
            >
              <div className="card-head">
                <span className="step-num">2</span>
                <h3>Adopt what is already installed</h3>
              </div>
              <div className="card-body col">
                {saves.data?.found ? (
                  <div className="notice" data-kind="warn">
                    <span className="notice-mark" />
                    <div>
                      <strong>
                        {saves.data.slots.length} save slot{saves.data.slots.length === 1 ? '' : 's'} found on this machine
                      </strong>
                      <div className="faint" style={{ marginTop: 2 }}>
                        <span className="mono">{saves.data.path}</span> — {formatBytes(saves.data.sizeBytes)}
                        {saves.data.hasSettings ? ', plus gta_sa.set' : ''}. They will be copied into this profile and
                        snapshotted before anything else happens, so switching profiles can never lose them. The
                        originals stay exactly where they are.
                      </div>
                    </div>
                  </div>
                ) : null}

                <Field label="Profile name" hint="The profile that will hold your current setup.">
                  <input className="input" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
                </Field>

                <div className="row">
                  <Button variant="primary" disabled={busy || !profileName.trim()} onClick={adopt}>
                    {busy ? 'Indexing…' : 'Adopt this install'}
                  </Button>
                  <span className="faint">Read-only: every file stays where it is.</span>
                </div>
              </div>
            </motion.section>
          ) : null}
        </AnimatePresence>

        {/* step 3 */}
        <AnimatePresence>
          {report ? (
            <motion.section className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={smooth}>
              <div className="card-head">
                <span className="step-num">
                  <Icon.check width={11} height={11} />
                </span>
                <h3>Adopted</h3>
                <span className="spacer" />
                <span className="faint num">{report.length} item(s)</span>
              </div>
              <div className="card-body col">
                <pre className="pre" style={{ maxHeight: 260 }}>
                  {report.join('\n')}
                </pre>
                <div className="row">
                  <Button variant="primary" onClick={() => setScreen('library')}>
                    Open the library
                  </Button>
                  <Button variant="quiet" onClick={() => setScreen('health')}>
                    Run the pre-launch check
                  </Button>
                </div>
              </div>
            </motion.section>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
