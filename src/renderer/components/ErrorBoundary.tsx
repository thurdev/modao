import React from 'react'
import { Button } from './ui'
import { useT } from '../lib/i18n'

interface Props {
  children: React.ReactNode
  /** Changing this resets the boundary - used to recover when the user navigates. */
  resetKey: string
}

interface State {
  error: Error | null
}

/**
 * A rendering fault in one screen must not take the whole app down: the user
 * may be mid-install, and the main process is still holding a transaction.
 * The boundary shows what broke, offers a retry, and leaves the shell usable.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return <ErrorFallback error={error} onRetry={() => this.setState({ error: null })} />
  }
}

/**
 * The fallback lives in its own function component because the boundary itself
 * has to be a class - and the translator is a hook.
 */
function ErrorFallback(props: { error: Error; onRetry: () => void }): JSX.Element {
  const t = useT()
  return (
    <div className="notice" data-kind="error">
      <span className="notice-mark" />
      <div className="col" style={{ gap: 8 }}>
        <strong>{t('shell.screenFailed')}</strong>
        <span className="muted">
          {t('shell.nothingTouched')} {props.error.message}
        </span>
        <pre className="pre" style={{ maxHeight: 180 }}>
          {props.error.stack ?? String(props.error)}
        </pre>
        <span>
          <Button size="sm" onClick={props.onRetry}>
            {t('app.retry')}
          </Button>
        </span>
      </div>
    </div>
  )
}
