import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { UpdateProgress, UpdateStatus } from '@shared/types'
import { api, formatBytes } from '../api'
import { useApp } from '../state/store'
import { useT } from '../lib/i18n'
import { snappy } from '../lib/motion'
import { Button } from './ui'
import { Icon } from './icons'

/**
 * A new version is worth one line, once - and then it installs itself.
 *
 * The app downloads the release, replaces itself and starts again, so nobody
 * has to visit a web page and run an installer to get a fix. Both steps are the
 * user's call: nothing downloads until they press the button, and nothing
 * restarts until they press the other one, because they may be halfway through
 * installing a seven-gigabyte mod.
 */
export function UpdateNotice(): JSX.Element | null {
  const t = useT()
  const pushToast = useApp((s) => s.pushToast)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [ready, setReady] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .checkUpdate()
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        if (s.downloadedVersion) setReady(s.downloadedVersion)
      })
      .catch(() => undefined)

    const off = api.onUpdateEvent((event) => {
      if (event.kind === 'progress') setProgress(event.payload as UpdateProgress)
      if (event.kind === 'ready') {
        setProgress(null)
        setBusy(false)
        setReady((event.payload as { version: string }).version)
      }
      if (event.kind === 'error') {
        setProgress(null)
        setBusy(false)
        pushToast('error', (event.payload as { message: string }).message)
      }
    })
    return () => {
      cancelled = true
      off()
    }
  }, [pushToast])

  // A failed check is shown too: silence reads as "no update", which is the
  // one thing it does not mean.
  const show =
    !hidden && !!status && (ready !== null || (status.available && !status.dismissed) || !!status.error)
  if (!show || !status) return null

  return (
    <AnimatePresence initial={false}>
      <motion.div
        className="notice"
        data-kind="accent"
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={snappy}
        style={{ marginBottom: 12 }}
      >
        <span className="notice-mark" />
        <div className="col" style={{ gap: 6, flex: 1 }}>
          <strong>
            {ready
              ? t('updates.readyToInstall', { version: ready })
              : t('updates.available', { version: status.latest ?? '' })}
          </strong>
          <span className="faint">
            {status.error
              ? t('updates.checkFailed', { error: status.error })
              : ready
                ? t('updates.restartExplains')
                : t('updates.optional', { current: status.current })}
          </span>

          {progress ? (
            <div className="col" style={{ gap: 4 }}>
              <div className="progress">
                <span className="progress-bar" style={{ width: `${progress.percent}%` }} />
              </div>
              <span className="faint num">
                {t('updates.downloading', {
                  percent: progress.percent,
                  size: formatBytes(progress.total),
                  speed: formatBytes(progress.bytesPerSecond)
                })}
              </span>
            </div>
          ) : (
            <span className="row wrap">
              {ready ? (
                <Button
                  size="sm"
                  variant="accent"
                  disabled={busy}
                  icon={<Icon.refresh width={13} height={13} />}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await api.installUpdate()
                    } catch (e) {
                      setBusy(false)
                      pushToast('error', (e as Error).message)
                    }
                  }}
                >
                  {t('updates.restartAndInstall')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="accent"
                  disabled={busy}
                  icon={<Icon.download width={13} height={13} />}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      // One decision: it downloads, installs and comes back.
                      const result = await api.downloadUpdate(true)
                      if (!result.started) {
                        setBusy(false)
                        pushToast('info', result.message)
                      }
                    } catch (e) {
                      setBusy(false)
                      pushToast('error', (e as Error).message)
                    }
                  }}
                >
                  {busy ? t('updates.starting') : t('updates.updateAndRestart')}
                </Button>
              )}
              {status.releaseUrl ? (
                <Button
                  size="sm"
                  variant="quiet"
                  icon={<Icon.external width={13} height={13} />}
                  onClick={() => void api.openExternal(status.releaseUrl as string)}
                >
                  {t('updates.whatsNew')}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="quiet"
                onClick={async () => {
                  setHidden(true)
                  if (status.latest) await api.dismissUpdate(status.latest).catch(() => undefined)
                }}
              >
                {t('updates.dismiss')}
              </Button>
            </span>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
