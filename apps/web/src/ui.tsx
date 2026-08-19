import type { ReactNode } from 'react'

const documentBoundaryPaths = ['/admin', '/reviewer', '/speaker-portal', '/submit'] as const

function documentBoundary(pathname: string) {
  const rootBoundary = documentBoundaryPaths.find((path) => pathname === path || pathname.startsWith(`${path}/`))
  if (rootBoundary) return rootBoundary

  const eventBoundary = pathname.match(/^\/events\/[^/]+\/(admin|reviewer|speaker|submit)(?:\/|$)/)
  return eventBoundary?.[0].replace(/\/$/, '')
}

export function requiresDocumentNavigation(to: string) {
  const url = new URL(to, window.location.origin)
  if (url.origin !== window.location.origin) return true

  const targetBoundary = documentBoundary(url.pathname)
  if (!targetBoundary) return false
  return documentBoundary(window.location.pathname) !== targetBoundary
}

export function Link({ to, className, children, onClick, ariaCurrent, ariaLabel }: { to: string; className?: string; children: ReactNode; onClick?: () => void; ariaCurrent?: 'page'; ariaLabel?: string }) {
  return (
    <a
      href={to}
      className={className}
      aria-current={ariaCurrent}
      aria-label={ariaLabel}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        onClick?.()
        if (requiresDocumentNavigation(to)) return
        event.preventDefault()
        window.history.pushState({}, '', to)
        window.dispatchEvent(new PopStateEvent('popstate'))
        window.scrollTo(0, 0)
      }}
    >
      {children}
    </a>
  )
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-header"><div><p>{eyebrow}</p><h1>{title}</h1><span>{description}</span></div>{action}</div>
}

export function TaskTabs({ label, tabs, active, onChange }: { label: string; tabs: readonly { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return <nav className="task-tabs" aria-label={label}>{tabs.map((tab) => <button key={tab.id} type="button" aria-pressed={active === tab.id} onClick={() => onChange(tab.id)}>{tab.label}</button>)}</nav>
}
