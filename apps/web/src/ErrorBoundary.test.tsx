import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from './ErrorBoundary'

function Explode({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('speaker roster is not an array')
  return <p>Program loaded</p>
}

function FailedChunk({ message }: { message: string }): never {
  throw new Error(message)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(<ErrorBoundary><Explode shouldThrow={false} /></ErrorBoundary>)

    expect(screen.getByText('Program loaded')).toBeInTheDocument()
  })

  it('replaces a crashed tree with a recoverable message instead of a blank page', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<ErrorBoundary><Explode shouldThrow /></ErrorBoundary>)

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('never shows the thrown message, which can carry internal detail', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<ErrorBoundary><Explode shouldThrow /></ErrorBoundary>)

    expect(screen.queryByText(/speaker roster is not an array/)).not.toBeInTheDocument()
  })

  // React.lazy caches a rejected import, so re-rendering throws the same error
  // forever. Offering "Try again" for these would be a button that cannot work.
  it.each([
    ['Chrome', 'Failed to fetch dynamically imported module: /assets/ConnectedAgendaAdmin-B02ey21S.js'],
    ['Firefox', 'error loading dynamically imported module'],
    ['Safari', 'Importing a module script failed.'],
  ])('offers a reload rather than a retry for a stale chunk (%s wording)', (_browser, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<ErrorBoundary><FailedChunk message={message} /></ErrorBoundary>)

    expect(screen.getByRole('heading', { name: 'This page needs to reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('does not misclassify a generic fetch failure as a stale chunk', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<ErrorBoundary><FailedChunk message="Failed to fetch" /></ErrorBoundary>)

    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reload page' })).not.toBeInTheDocument()
  })

  it('recovers when the retry succeeds', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(<ErrorBoundary><Explode shouldThrow /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // Simulate the transient cause clearing before the visitor retries.
    rerender(<ErrorBoundary><Explode shouldThrow={false} /></ErrorBoundary>)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('Program loaded')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
