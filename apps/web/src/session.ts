import { ApiError } from './api'

const configuredDefaultEventSlug = import.meta.env.VITE_DEFAULT_EVENT_SLUG?.trim()
const publicSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isEventSlug(value: string) {
  return publicSlugPattern.test(value)
}

export const DEFAULT_EVENT_SLUG = configuredDefaultEventSlug && isEventSlug(configuredDefaultEventSlug)
  ? configuredDefaultEventSlug
  : 'devflow-conf-2027'

export type EventWorkspace = 'admin' | 'submit' | 'reviewer' | 'speaker' | 'program'

export function eventWorkspacePath(eventSlug: string, workspace: EventWorkspace, detail?: string) {
  const base = `/events/${encodeURIComponent(eventSlug)}/${workspace}`
  return detail ? `${base}/${encodeURIComponent(detail)}` : base
}

export function asApiError(error: unknown) {
  return error instanceof ApiError
    ? error
    : new ApiError(0, 'NETWORK_ERROR', error instanceof Error ? error.message : 'The request could not be completed.')
}

export function isAuthenticationError(error: unknown) {
  const apiError = asApiError(error)
  return apiError.code === 'UNAUTHENTICATED'
}

export function isAccessError(error: unknown) {
  const apiError = asApiError(error)
  return apiError.code === 'UNAUTHENTICATED' || apiError.code === 'FORBIDDEN'
}
