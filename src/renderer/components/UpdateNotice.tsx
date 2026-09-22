import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { UpdateStatus } from '@shared/types'
import { api } from '../api'
import { useT } from '../lib/i18n'
import { snappy } from '../lib/motion'
import { Button } from './ui'
import { Icon } from './icons'

/**
 * A new release is worth one line, once.
 *
 * It appears when the app starts and a newer version exists, it never installs
 * anything, and dismissing it is remembered for that exact version - so the
 * same release cannot ask twice. Whatever is dismissed here stays visible in
 * Settings, where there is also a button to look again.
 */
export function UpdateNotice(): JSX.Element | null {
  const t = useT()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .checkUpdate()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const show = !!status && status.available && !status.dismissed && !hidden

  return (
    <AnimatePresence initial={false}>
      {show && status ? (
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
          <div className="col" style={{ gap: 6 }}>
            <strong>{t('updates.available', { version: status.latest ?? '' })}</strong>
            <span className="faint">{t('updates.optional', { current: status.current })}</span>
            <span className="row wrap">
              <Button
                size="sm"
                variant="accent"
                icon={<Icon.external width={13} height={13} />}
                onClick={() => status.releaseUrl && void api.openExternal(status.releaseUrl)}
              >
                {t('updates.open')}
              </Button>
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
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
