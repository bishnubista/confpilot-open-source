import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventWorkspacePath } from './session'
import { Link, requiresDocumentNavigation } from './ui'

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Link navigation boundaries', () => {
  it('requires a new document for role workspaces and the public submission form', () => {
    expect(requiresDocumentNavigation('/admin')).toBe(true)
    expect(requiresDocumentNavigation('/admin/agenda')).toBe(true)
    expect(requiresDocumentNavigation('/reviewer/assignments/assignment-1')).toBe(true)
    expect(requiresDocumentNavigation('/speaker-portal')).toBe(true)
    expect(requiresDocumentNavigation('/submit')).toBe(true)
    expect(requiresDocumentNavigation('/program')).toBe(false)
  })

  it('keeps navigation within the current role workspace in the single-page app', () => {
    window.history.replaceState({}, '', '/admin')
    expect(requiresDocumentNavigation('/admin/agenda')).toBe(false)
    expect(requiresDocumentNavigation('/reviewer')).toBe(true)
  })

  it('separates event-scoped role and event workspaces while preserving in-workspace navigation', () => {
    window.history.replaceState({}, '', eventWorkspacePath('alpha-conf', 'admin'))
    expect(requiresDocumentNavigation(`${eventWorkspacePath('alpha-conf', 'admin')}/agenda`)).toBe(false)
    expect(requiresDocumentNavigation(eventWorkspacePath('alpha-conf', 'reviewer'))).toBe(true)
    expect(requiresDocumentNavigation(eventWorkspacePath('beta-conf', 'admin'))).toBe(true)
    expect(requiresDocumentNavigation(eventWorkspacePath('alpha-conf', 'program'))).toBe(false)
  })

  it('does not replace protected-route responses with client-side history navigation', () => {
    const pushState = vi.spyOn(window.history, 'pushState')
    let componentPreventedDefault = true
    const preventNavigation = (event: MouseEvent) => {
      componentPreventedDefault = event.defaultPrevented
      event.preventDefault()
    }
    document.addEventListener('click', preventNavigation)

    render(<Link to="/admin/agenda">Open agenda</Link>)
    fireEvent.click(screen.getByRole('link', { name: 'Open agenda' }))

    document.removeEventListener('click', preventNavigation)
    expect(componentPreventedDefault).toBe(false)
    expect(pushState).not.toHaveBeenCalled()
  })

  it('keeps ordinary public navigation inside the single-page app', () => {
    const pushState = vi.spyOn(window.history, 'pushState')
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)

    render(<Link to="/program">View program</Link>)
    fireEvent.click(screen.getByRole('link', { name: 'View program' }))

    expect(pushState).toHaveBeenCalledWith({}, '', '/program')
  })

  it('updates history when navigating within the organizer workspace', () => {
    window.history.replaceState({}, '', '/admin')
    const pushState = vi.spyOn(window.history, 'pushState')
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)

    render(<Link to="/admin/agenda">Open agenda</Link>)
    fireEvent.click(screen.getByRole('link', { name: 'Open agenda' }))

    expect(pushState).toHaveBeenCalledWith({}, '', '/admin/agenda')
  })
})
