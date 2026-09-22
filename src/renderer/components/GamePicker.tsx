import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { GAME_ORDER, gameDefinition, type GameKind } from '@shared/games'
import { useApp } from '../state/store'
import { api } from '../api'
import { Icon } from './icons'
import { snappy } from '../lib/motion'

/**
 * The game is the top-level choice: everything below it - profiles, library,
 * conflicts, saves, the catalogue - belongs to one install of one game. A mod
 * for Vice City cannot go into San Andreas, so rather than mixing them behind a
 * filter, the whole app follows whichever install is selected here.
 */
export function GamePicker(): JSX.Element {
  const { games, game, setActiveGame, pushToast, refreshGames } = useApp()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const current = game ? gameDefinition(game.kind) : null
  const others = games.filter((g) => g.id !== game?.id)

  async function choose(id: number): Promise<void> {
    setBusy(true)
    try {
      await setActiveGame(id)
      setOpen(false)
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** Adds another install: the folder picker, then whichever game is in it. */
  async function addAnother(): Promise<void> {
    setBusy(true)
    try {
      const folder = await api.pickGameFolder()
      if (!folder) return
      const added = await api.addGame(folder)
      await refreshGames()
      await setActiveGame(added.id)
      pushToast('success', `${added.gameName} added from ${added.path}.`)
      setOpen(false)
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="game-picker">
      <button
        className="game-current"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={game?.path ?? 'No game folder selected yet'}
      >
        <span className="game-chip" data-game={game?.kind ?? 'sa'}>
          {current?.shortName ?? '—'}
        </span>
        <span className="game-names">
          <span className="game-name">{current?.name ?? 'No game selected'}</span>
          <span className="game-path">{game ? game.path : 'Add your install to begin'}</span>
        </span>
        <Icon.chevron className={open ? 'rot' : ''} width={12} height={12} />
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="game-menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={snappy}
          >
            {others.map((g) => (
              <button key={g.id} className="game-option" disabled={busy} onClick={() => void choose(g.id)}>
                <span className="game-chip" data-game={g.kind}>
                  {gameDefinition(g.kind).shortName}
                </span>
                <span className="game-names">
                  <span className="game-name">{g.gameName}</span>
                  <span className="game-path">{g.path}</span>
                </span>
              </button>
            ))}
            {others.length === 0 ? (
              <div className="game-empty">
                Only one install so far. Modão manages {GAME_ORDER.map((k) => gameDefinition(k).shortName).join(', ')}.
              </div>
            ) : null}
            <button className="game-option add" disabled={busy} onClick={() => void addAnother()}>
              <span className="game-chip add">
                <Icon.plus width={12} height={12} />
              </span>
              <span className="game-names">
                <span className="game-name">Add another install</span>
                <span className="game-path">San Andreas, III, Vice City or the Definitive Edition</span>
              </span>
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/** The little square that says which game something belongs to. */
export function GameChip(props: { kind: GameKind; title?: string }): JSX.Element {
  const def = gameDefinition(props.kind)
  return (
    <span className="game-chip sm" data-game={def.kind} title={props.title ?? def.name}>
      {def.shortName}
    </span>
  )
}
