import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnstileWidget } from './TurnstileWidget'

describe('TurnstileWidget', () => {
  afterEach(() => {
    delete window.turnstile
    document.getElementById('cloudflare-turnstile-script')?.remove()
    vi.useRealTimers()
  })

  it('removes a failed script and lets the user retry verification', async () => {
    const onToken = vi.fn()
    const { container } = render(<TurnstileWidget siteKey="public-test-key" resetKey={0} onToken={onToken} />)
    const firstScript = document.getElementById('cloudflare-turnstile-script')
    expect(firstScript).toBeInstanceOf(HTMLScriptElement)

    fireEvent.error(firstScript!)
    expect(await screen.findByRole('button', { name: 'Retry verification' })).toBeInTheDocument()
    expect(document.getElementById('cloudflare-turnstile-script')).toBeNull()

    const renderWidget = vi.fn(() => 'widget-1')
    window.turnstile = { render: renderWidget, remove: vi.fn() }
    fireEvent.click(screen.getByRole('button', { name: 'Retry verification' }))

    await waitFor(() => expect(renderWidget).toHaveBeenCalledWith(
      container.querySelector('[aria-label="Account verification"]'),
      expect.objectContaining({ sitekey: 'public-test-key', action: 'speaker_registration' }),
    ))
    expect(screen.queryByRole('button', { name: 'Retry verification' })).not.toBeInTheDocument()
  })

  it('times out a stale existing script and retries with a fresh script', async () => {
    vi.useFakeTimers()
    const staleScript = document.createElement('script')
    staleScript.id = 'cloudflare-turnstile-script'
    document.head.append(staleScript)
    const removeEventListener = vi.spyOn(staleScript, 'removeEventListener')
    const onToken = vi.fn()
    const { container, unmount } = render(<TurnstileWidget siteKey="public-test-key" resetKey={0} onToken={onToken} />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(screen.getByRole('button', { name: 'Retry verification' })).toBeInTheDocument()
    expect(staleScript.isConnected).toBe(false)
    expect(removeEventListener).toHaveBeenCalledWith('load', expect.any(Function))
    expect(removeEventListener).toHaveBeenCalledWith('error', expect.any(Function))

    fireEvent.click(screen.getByRole('button', { name: 'Retry verification' }))
    const freshScript = document.getElementById('cloudflare-turnstile-script')
    expect(freshScript).toBeInstanceOf(HTMLScriptElement)
    expect(freshScript).not.toBe(staleScript)

    const renderWidget = vi.fn(() => 'widget-2')
    const removeWidget = vi.fn()
    window.turnstile = { render: renderWidget, remove: removeWidget }
    fireEvent.load(freshScript!)
    await act(async () => Promise.resolve())

    expect(renderWidget).toHaveBeenCalledWith(
      container.querySelector('[aria-label="Account verification"]'),
      expect.objectContaining({ sitekey: 'public-test-key', action: 'speaker_registration' }),
    )
    expect(vi.getTimerCount()).toBe(0)
    unmount()
    expect(removeWidget).toHaveBeenCalledWith('widget-2')
  })
})
