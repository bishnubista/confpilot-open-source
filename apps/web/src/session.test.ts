import type { AuthSession } from '@confpilot/contracts'
import { describe, expect, it } from 'vitest'

import { eventSlugForRole, hasEventRole, workspacePathForSession } from './auth'
import { eventWorkspacePath } from './session'

const session: AuthSession = {
  user: { id: 'user-1', email: 'user@example.test', displayName: 'Event Operator' },
  memberships: [
    { eventSlug: 'zebra-summit', role: 'organizer' },
    { eventSlug: 'alpha-conf', role: 'organizer' },
    { eventSlug: 'zebra-summit', role: 'speaker' },
  ],
}

describe('event-scoped frontend session helpers', () => {
  it('builds canonical paths for two distinct event slugs', () => {
    expect(eventWorkspacePath('alpha-conf', 'admin')).toBe('/events/alpha-conf/admin')
    expect(eventWorkspacePath('zebra-summit', 'reviewer', 'assignment/1')).toBe('/events/zebra-summit/reviewer/assignment%2F1')
  })

  it('denies a role membership from the wrong event', () => {
    expect(hasEventRole(session, 'zebra-summit', 'speaker')).toBe(true)
    expect(hasEventRole(session, 'alpha-conf', 'speaker')).toBe(false)
  })

  it('selects the first matching membership deterministically for unscoped entry points', () => {
    expect(eventSlugForRole(session, 'organizer')).toBe('alpha-conf')
    expect(workspacePathForSession(session)).toBe('/events/alpha-conf/admin')
  })
})
