import { useState } from 'react'
import { motion } from 'motion/react'
import { api } from '../api'
import { useApp } from '../state/store'
import { useT } from '../lib/i18n'
import { Button, Checkbox, useAsync } from './ui'
import { Icon } from './icons'
import { snappy } from '../lib/motion'

/**
 * Shown whenever Windows will not let Modão write into the game folder -
 * which is most repacks, because they install under Program Files.
 *
 * Two real fixes are offered, in the order that leaves the user better off:
 * move the game out of a protected folder (permanent, and the modding scene
 * recommends it anyway), or restart Modão elevated (immediate). Elevation is
 * never the default: an elevated Modão would extract and handle every mod
 * archive with full privileges, and the installs that need it are the minority.
 */
export function AccessBanner(): JSX.Element | null {
  const t = useT()
  const { game, refreshGames, pushToast } = useApp()
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const elevation = useAsync(() => api.elevation(), [game?.path])

  if (!game || game.access.writable) return null

  const reason = game.access.reason ?? elevation.data?.reason
  const canElevate = game.access.needsElevation && !elevation.data?.running

  async function restartElevated(): Promise<void> {
    setBusy(true)
    try {
      await api.relaunchElevated(remember)
    } catch (e) {
      pushToast('error', (e as Error).message)
      setBusy(false)
    }
  }

  async function recheck(): Promise<void> {
    setBusy(true)
    try {
      const access = await api.recheckAccess()
      await refreshGames()
      pushToast(
        access.writable ? 'success' : 'error',
        access.writable ? t('install.access.writeConfirmed') : (access.reason ?? t('install.access.stillBlocked'))
      )
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div
      className="notice"
      data-kind="error"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={snappy}
      style={{ margin: '0 24px 14px' }}
    >
      <span className="notice-mark" />
      <div className="col" style={{ gap: 9, minWidth: 0 }}>
        <strong>{t('install.access.title')}</strong>
        <span className="mono ellipsis" title={game.path}>
          {game.path}
        </span>
        <span className="muted">{reason ?? t('install.access.deniedFallback')}</span>
        <span className="faint">{t('install.access.consequence')}</span>

        <div className="row wrap">
          {canElevate ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={restartElevated} icon={<Icon.bolt width={13} height={13} />}>
              {busy ? t('install.access.askingWindows') : t('install.access.restartAdmin')}
            </Button>
          ) : null}
          <Button size="sm" variant="quiet" disabled={busy} onClick={recheck} icon={<Icon.refresh width={13} height={13} />}>
            {t('install.access.checkAgain')}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => void api.revealPath(game.path)} icon={<Icon.folder width={13} height={13} />}>
            {t('install.access.showFolder')}
          </Button>
        </div>

        {canElevate ? (
          <label className="row faint" style={{ gap: 7 }}>
            <Checkbox on={remember} onChange={setRemember} label={t('install.access.rememberLabel')} />
            {t('install.access.rememberHint')}
          </label>
        ) : null}

        {elevation.data?.protectedPath ? (
          <span className="faint">
            {t('install.access.betterFixLead')} <span className="mono">D:\Games\GTA San Andreas</span>
            {t('install.access.betterFixTail')}
          </span>
        ) : null}
      </div>
    </motion.div>
  )
}
