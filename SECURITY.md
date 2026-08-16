# Security policy

ConfPilot is pre-release software and has not completed an independent security assessment. Do not use it for production attendee data until the self-hosting, recovery, authentication, and privacy gates are complete.

## Reporting a vulnerability

Do not include exploit details, credentials, personal data, or private deployment information in a public issue.

Use the repository's private security-advisory reporting channel when it is enabled. If no private channel is visible, open a public issue containing only a request for a private reporting channel and no vulnerability details. Maintainers should acknowledge a private report, establish a safe communication channel, and provide a remediation-status update before requesting disclosure.

There is currently no paid support or guaranteed response-time commitment. If active exploitation may affect your deployment, disable the affected public surface, preserve privacy-safe evidence, rotate exposed credentials through the owning provider, and follow your incident-response process.

## Supported versions

Before the first tagged release, only the current `main` branch receives security fixes. After tagged releases begin, the project will document the supported release line here. Self-hosters are responsible for monitoring releases and applying supported updates.

## Deployment boundary

Each operator owns their Cloudflare account, Worker configuration, D1 and R2 data, Turnstile widget, DNS, secrets, backups, logs, billing, and access controls. Keep R2 private, keep the application and API on one origin, never use demo seeds in production, and never commit account identifiers or secrets.
