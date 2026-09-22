import { useState } from 'react'
import { motion } from 'motion/react'
import { api } from '../api'
import { useApp } from '../state/store'
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
      pushToast(access.writable ? 'success' : 'error', access.writable ? 'Write access confirmed.' : (access.reason ?? 'Still blocked.'))
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
        <strong>Modão cannot write to the game folder</strong>
        <span className="mono ellipsis" title={game.path}>
          {game.path}
        </span>
        <span className="muted">{reason ?? 'Windows denied the write.'}</span>
        <span className="faint">
          Until this is fixed every action that changes the game — switching profiles, installing, enabling a mod,
          writing modloader.ini — will refuse rather than half-apply. Nothing has been changed.
        </span>

        <div className="row wrap">
          {canElevate ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={restartElevated} icon={<Icon.bolt width={13} height={13} />}>
              {busy ? 'Asking Windows…' : 'Restart as administrator'}
            </Button>
          ) : null}
          <Button size="sm" variant="quiet" disabled={busy} onClick={recheck} icon={<Icon.refresh width={13} height={13} />}>
            Check again
          </Button>
          <Button size="sm" variant="quiet" onClick={() => void api.revealPath(game.path)} icon={<Icon.folder width={13} height={13} />}>
            Show the folder
          </Button>
        </div>

        {canElevate ? (
          <label className="row faint" style={{ gap: 7 }}>
            <Checkbox on={remember} onChange={setRemember} label="Always start elevated for this install" />
            Ask for administrator rights automatically next time
          </label>
        ) : null}

        {elevation.data?.protectedPath ? (
          <span className="faint">
            Better long-term fix: move the game somewhere like <span className="mono">D:\Games\GTA San Andreas</span>.
            Program Files also breaks a lot of mods that write next to the exe, and running elevated means every archive
            Modão extracts is handled with full privileges.
          </span>
        ) : null}
      </div>
    </motion.div>
  )
}
