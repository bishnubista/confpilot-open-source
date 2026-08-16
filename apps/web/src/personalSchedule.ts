import type { PersonalCalendarRequest } from '@confpilot/contracts'

const STORAGE_PREFIX = 'confpilot:personal-schedule:v1:'
export const MAX_PERSONAL_SCHEDULE_SESSIONS = 100

function storageKey(eventSlug: string) {
  return `${STORAGE_PREFIX}${eventSlug}`
}

export function loadPersonalSchedule(eventSlug: string, publicSessionSlugs: string[]) {
  const available = new Set(publicSessionSlugs)
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey(eventSlug)) ?? '[]')
    if (!Array.isArray(stored)) return new Set<string>()
    return new Set(stored
      .filter((slug): slug is string => typeof slug === 'string' && available.has(slug))
      .slice(0, MAX_PERSONAL_SCHEDULE_SESSIONS))
  } catch {
    return new Set<string>()
  }
}

export function savePersonalSchedule(eventSlug: string, sessionSlugs: Set<string>) {
  try {
    window.localStorage.setItem(storageKey(eventSlug), JSON.stringify([...sessionSlugs].sort()))
  } catch {
    // Browsing the public program still works when storage is unavailable.
  }
}

export async function downloadPersonalSchedule(eventSlug: string, sessionSlugs: string[]) {
  const request: PersonalCalendarRequest = { event: eventSlug, sessionSlugs }
  const response = await fetch('/api/program.ics', {
    method: 'POST',
    headers: {
      accept: 'text/calendar',
      'content-type': 'application/json',
      'x-confpilot-request': '1',
    },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error('Personal schedule download failed')

  const objectUrl = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = `${eventSlug}-my-schedule.ics`
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}
