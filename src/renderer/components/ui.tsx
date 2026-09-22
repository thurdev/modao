import React, { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from './icons'
import { collapseVariants, modalVariants, scrimVariants, snappy, springy } from '../lib/motion'

// ───────────────────────────── buttons and inputs ─────────────────────────────

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'quiet' | 'danger' | 'accent'
  size?: 'sm' | 'md' | 'lg'
  icon?: React.ReactNode
  iconOnly?: boolean
}

export function Button({ variant = 'default', size = 'md', icon, iconOnly, children, ...rest }: ButtonProps): JSX.Element {
  const cls = [
    'btn',
    variant !== 'default' ? variant : '',
    size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : '',
    iconOnly ? 'icon' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={cls} {...rest}>
      {icon}
      {children}
    </button>
  )
}

export function Search(props: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }): JSX.Element {
  return (
    <span className="search" style={{ width: props.width ?? 260 }}>
      <Icon.search />
      <input
        className="input"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </span>
  )
}

export function Field(props: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="field">
      <label>{props.label}</label>
      {props.children}
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </div>
  )
}

export function Switch(props: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className="switch"
      data-on={props.on}
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    >
      <motion.span className="knob" layout transition={springy} style={{ left: props.on ? 15 : 1.5 }} />
    </button>
  )
}

export function Checkbox(props: { on: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <button
      type="button"
      className="check"
      data-on={props.on}
      role="checkbox"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={() => props.onChange(!props.on)}
    >
      <AnimatePresence initial={false}>
        {props.on ? (
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={snappy}
            style={{ display: 'grid' }}
          >
            <Icon.check width={10} height={10} strokeWidth={2.2} />
          </motion.span>
        ) : null}
      </AnimatePresence>
    </button>
  )
}

/** Priority editor: 0 means "ignored by Mod Loader", so the value is never hidden behind a slider. */
export function Stepper(props: { value: number; min?: number; max?: number; onCommit: (v: number) => void }): JSX.Element {
  const [local, setLocal] = useState(String(props.value))
  useEffect(() => setLocal(String(props.value)), [props.value])
  const min = props.min ?? 0
  const max = props.max ?? 100
  const commit = (raw: string): void => {
    const n = Math.max(min, Math.min(max, Number.parseInt(raw, 10) || 0))
    setLocal(String(n))
    if (n !== props.value) props.onCommit(n)
  }
  return (
    <span className="stepper">
      <button type="button" aria-label="decrease" onClick={() => commit(String(props.value - 5))}>
        −
      </button>
      <input
        type="number"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
      />
      <button type="button" aria-label="increase" onClick={() => commit(String(props.value + 5))}>
        +
      </button>
    </span>
  )
}

// ───────────────────────────── surfaces ─────────────────────────────

export function Badge(props: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'
  children: React.ReactNode
  dot?: boolean
  title?: string
}): JSX.Element {
  return (
    <span className={`badge ${props.tone && props.tone !== 'neutral' ? props.tone : ''}`} title={props.title}>
      {props.dot ? <span className="dot" /> : null}
      {props.children}
    </span>
  )
}

export function Modal(props: {
  title: string
  subtitle?: React.ReactNode
  onClose: () => void
  footer?: React.ReactNode
  children: React.ReactNode
  width?: number
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <motion.div
      className="scrim"
      variants={scrimVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <motion.div
        className="modal"
        variants={modalVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={props.width ? { width: props.width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <div className="modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{props.title}</h2>
            {props.subtitle ? (
              <div className="faint" style={{ marginTop: 3 }}>
                {props.subtitle}
              </div>
            ) : null}
          </div>
          <Button variant="quiet" size="sm" iconOnly aria-label="Close" onClick={props.onClose} icon={<Icon.close />} />
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <div className="modal-foot">{props.footer}</div> : null}
      </motion.div>
    </motion.div>
  )
}

export function Confirm(props: {
  title: string
  body: React.ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void | Promise<void>
  onClose: () => void
}): JSX.Element {
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      width={640}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <span className="spacer" />
          <Button variant={props.danger ? 'danger' : 'primary'} disabled={props.busy} onClick={() => void props.onConfirm()}>
            {props.busy ? 'Working…' : props.confirmLabel}
          </Button>
        </>
      }
    >
      {props.body}
    </Modal>
  )
}

export function Empty(props: { title: string; hint?: React.ReactNode; art?: string; action?: React.ReactNode }): JSX.Element {
  return (
    <motion.div className="empty" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={snappy}>
      {props.art ? <img src={props.art} alt="" /> : null}
      <strong>{props.title}</strong>
      {props.hint ? <p>{props.hint}</p> : null}
      {props.action}
    </motion.div>
  )
}

export function Tabs<T extends string>(props: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: string }[]
}): JSX.Element {
  const group = useId()
  return (
    <div className="tabs" role="tablist">
      {props.options.map((o) => (
        <button
          key={o.id}
          role="tab"
          className="tab"
          aria-selected={props.value === o.id}
          onClick={() => props.onChange(o.id)}
        >
          {props.value === o.id ? <motion.span layoutId={`tab-${group}`} className="tab-pill" transition={springy} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Disclosure(props: { open: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {props.open ? (
        <motion.div variants={collapseVariants} initial="initial" animate="animate" exit="exit" style={{ overflow: 'hidden' }}>
          {props.children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export function StatusDot(props: { status: 'pass' | 'warn' | 'fail' | 'skip' }): JSX.Element {
  return <span className="status-dot" data-status={props.status} />
}

/** A five-bar meter. Used for the synthesised ranking, never as a star rating. */
export function Rank(props: { value: number }): JSX.Element {
  const filled = Math.round(props.value * 5)
  return (
    <span className="rank" title={`${Math.round(props.value * 100)} / 100 synthesised`}>
      <span className="rank-bars">
        {[0, 1, 2, 3, 4].map((i) => (
          <i key={i} data-on={i < filled} style={{ height: 5 + i * 1.8 }} />
        ))}
      </span>
      <span className="faint num">{Math.round(props.value * 100)}</span>
    </span>
  )
}

export function Progress(props: { value: number }): JSX.Element {
  return (
    <div className="meter">
      <motion.div animate={{ width: `${Math.max(2, Math.min(100, props.value))}%` }} transition={snappy} />
    </div>
  )
}

// ───────────────────────────── data loading ─────────────────────────────

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[]
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const ref = useRef(fn)
  ref.current = fn

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ref
      .current()
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  return { data, loading, error, reload: () => setNonce((n) => n + 1) }
}

export function Loading(props: { label?: string }): JSX.Element {
  return (
    <div className="row faint" style={{ padding: '14px 2px' }}>
      <motion.span
        style={{ width: 9, height: 9, borderRadius: 3, background: 'var(--accent)' }}
        animate={{ opacity: [0.35, 1, 0.35] }}
        transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
      />
      {props.label ?? 'Loading…'}
    </div>
  )
}

export function ErrorNote(props: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="notice" data-kind="error">
      <span className="notice-mark" />
      <div className="col" style={{ gap: 6 }}>
        <strong>Something went wrong</strong>
        <span className="muted">{props.message}</span>
        {props.onRetry ? (
          <span>
            <Button size="sm" onClick={props.onRetry}>
              Try again
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  )
}
