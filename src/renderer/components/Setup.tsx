import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ExistingSavesReport, GameInstall } from '@shared/types'
import { api, formatBytes } from '../api'
import { useApp } from '../state/store'
import { useT } from '../lib/i18n'
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
  const t = useT()
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
            <h1 style={{ fontSize: 21 }}>{t('install.setup.title')}</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              {t('install.setup.intro')}
            </p>
          </div>
        </motion.div>

        {/* step 1 */}
        <motion.section variants={itemVariants} className="card">
          <div className="card-head">
            <span className="step" data-done={!!added} style={{ gridTemplateColumns: '22px' }}>
              <span className="step-num">{added ? <Icon.check width={11} height={11} /> : '1'}</span>
            </span>
            <h3>{t('install.setup.step1Title')}</h3>
          </div>
          <div className="card-body col">
            {added ? (
              <dl className="kv">
                <dt>{t('install.setup.folder')}</dt>
                <dd className="mono">{added.path}</dd>
                <dt>{t('install.setup.executable')}</dt>
                <dd>
                  {added.isV1UsOriginal ? t('install.setup.exeStock') : t('install.setup.exeNonStock')} ·{' '}
                  {t('install.setup.exeBytes', { bytes: added.exeSize.toLocaleString() })} ·{' '}
                  {added.largeAddressAware ? t('install.setup.laaSet') : t('install.setup.laaNotSet')}
                </dd>
                <dt>{t('install.setup.modLoader')}</dt>
                <dd>{added.hasModLoader ? (added.modLoaderVersion ?? t('install.setup.installed')) : t('install.setup.notInstalled')}</dd>
                <dt>{t('install.setup.asiDirectory')}</dt>
                <dd className="mono">{added.asiDirectory ?? t('install.setup.noneDetected')}</dd>
                <dt>{t('install.setup.cleo')}</dt>
                <dd>{added.cleoVersion ?? t('install.setup.notInstalled')}</dd>
                <dt>{t('install.setup.writeAccess')}</dt>
                <dd>
                  {added.access.writable
                    ? t('install.setup.writableTo', { path: added.access.probedPath })
                    : (added.access.reason ?? t('install.setup.writeDeniedFallback'))}
                </dd>
                <dt>{t('install.setup.modStore')}</dt>
                <dd>
                  {added.sameVolumeAsStore ? t('install.setup.sameVolume') : t('install.setup.diffVolume')}
                </dd>
              </dl>
            ) : (
              <>
                {candidates.loading ? <Loading label={t('install.setup.looking')} /> : null}
                {(candidates.data ?? []).map((p) => (
                  <div key={p} className="row between">
                    <span className="mono ellipsis" title={p}>
                      {p}
                    </span>
                    <Button size="sm" disabled={busy} onClick={() => add(p)}>
                      {t('install.setup.useThis')}
                    </Button>
                  </div>
                ))}
                {candidates.data && candidates.data.length === 0 ? (
                  <p className="faint" style={{ margin: 0 }}>
                    {t('install.setup.nothingFound')}
                  </p>
                ) : null}
                <div>
                  <Button variant="primary" disabled={busy} icon={<Icon.folder width={13} height={13} />} onClick={async () => {
                    const picked = await api.pickGameFolder()
                    if (picked) await add(picked)
                  }}>
                    {t('install.setup.browseFolder')}
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
                <h3>{t('install.setup.step2Title')}</h3>
              </div>
              <div className="card-body col">
                {saves.data?.found ? (
                  <div className="notice" data-kind="warn">
                    <span className="notice-mark" />
                    <div>
                      <strong>{t('install.setup.savesFound', { count: saves.data.slots.length })}</strong>
                      <div className="faint" style={{ marginTop: 2 }}>
                        <span className="mono">{saves.data.path}</span> — {formatBytes(saves.data.sizeBytes)}
                        {saves.data.hasSettings ? t('install.setup.savesPlusSettings') : ''}
                        {t('install.setup.savesExplain')}
                      </div>
                    </div>
                  </div>
                ) : null}

                <Field label={t('install.setup.profileNameLabel')} hint={t('install.setup.profileNameHint')}>
                  <input className="input" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
                </Field>

                <div className="row">
                  <Button variant="primary" disabled={busy || !profileName.trim()} onClick={adopt}>
                    {busy ? t('install.setup.indexing') : t('install.setup.adoptButton')}
                  </Button>
                  <span className="faint">{t('install.setup.readOnlyHint')}</span>
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
                <h3>{t('install.setup.step3Title')}</h3>
                <span className="spacer" />
                <span className="faint num">{t('install.setup.itemCount', { count: report.length })}</span>
              </div>
              <div className="card-body col">
                <pre className="pre" style={{ maxHeight: 260 }}>
                  {report.join('\n')}
                </pre>
                <div className="row">
                  <Button variant="primary" onClick={() => setScreen('library')}>
                    {t('install.setup.openLibrary')}
                  </Button>
                  <Button variant="quiet" onClick={() => setScreen('health')}>
                    {t('install.setup.runHealthCheck')}
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
