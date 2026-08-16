import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
  stale: boolean
}

/**
 * Recognise a dynamic import that could not be fetched.
 *
 * This is the normal consequence of deploying while someone has the site open:
 * their `index.html` references chunk hashes that no longer exist, so the next
 * lazy route 404s. Browsers word it differently, hence the several patterns.
 */
function isStaleChunkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i
    .test(message)
}

/**
 * Last-resort boundary around the whole application.
 *
 * Without this, one thrown render error unmounts the entire tree and leaves a
 * blank page. That is worst on the public program, where the visitor is an
 * attendee who cannot sign in, has no other route to the information, and has no
 * reason to suspect a reload would help.
 *
 * Two failures are distinguished because they need different actions:
 *
 * - A render error may be transient state, so remounting the subtree can clear
 *   it without losing the page.
 * - A stale-chunk error cannot be retried. `React.lazy` caches the rejected
 *   promise, so re-rendering throws the same error forever; only a reload
 *   fetches a fresh `index.html` with current chunk hashes.
 *
 * The message never includes the error text. A visitor cannot act on a stack
 * trace, and error strings can carry internal identifiers. Details go to the
 * console for the operator.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, stale: false }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failed: true, stale: isStaleChunkError(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled interface error', error, info.componentStack)
  }

  private retry = () => {
    this.setState({ failed: false, stale: false })
  }

  private reload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.failed) return this.props.children

    if (this.state.stale) {
      return (
        <main className="public-state" role="alert">
          <span aria-hidden="true">!</span>
          <h1>This page needs to reload</h1>
          <p>A newer version of ConfPilot was published while you were here. Reloading picks it up.</p>
          <button className="button button-primary" type="button" onClick={this.reload}>Reload page</button>
        </main>
      )
    }

    return (
      <main className="public-state" role="alert">
        <span aria-hidden="true">!</span>
        <h1>Something went wrong</h1>
        <p>This page could not be displayed. Trying again usually helps; if it does not, reload the page.</p>
        <button className="button button-primary" type="button" onClick={this.retry}>Try again</button>
      </main>
    )
  }
}
