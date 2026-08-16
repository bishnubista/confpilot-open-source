/**
 * Demo-workflow fixture, kept only for tests.
 *
 * The interactive demo store this file used to back was removed once every
 * route became API-connected. What remains is the localStorage key and the
 * seed state, which `App.test.tsx` writes directly to assert that demo data
 * never leaks into a connected route. Nothing in the application imports it.
 */

type ProposalStatus = 'Draft' | 'Submitted' | 'Accepted' | 'Waitlist' | 'Rejected'

interface DemoProposal {
  id: string
  title: string
  abstract: string
  track: string
  format: string
  takeaway: string
  audience: string
  participants: string[]
  status: ProposalStatus
}

interface DemoWorkflow {
  cfpPublished: boolean
  submissionLimit: number
  proposals: DemoProposal[]
  review: {
    originality: number
    relevance: number
    recommendation: string
    comment: string
    submitted: boolean
  }
  notification: 'not_sent' | 'queued'
  speaker: {
    bio: string
    tasks: Array<{ id: string; label: string; done: boolean }>
    files: Array<{ name: string; version: number; note: string }>
  }
  contentApproved: boolean
  embedEnabled: boolean
  programPublished: boolean
}

export const DEMO_STORAGE_KEY = 'confpilot-demo-workflow-v1'

export const initialWorkflow: DemoWorkflow = {
  cfpPublished: true,
  submissionLimit: 3,
  proposals: [
    {
      id: 'ABS-142',
      title: 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale',
      abstract: 'How content-addressed caching, remote execution, and test selection cut a forty-minute monorepo pipeline to six minutes without hiding failures.',
      track: 'Platform & Infra',
      format: 'Talk · 30m',
      takeaway: 'A repeatable migration plan for faster CI with trustworthy evidence.',
      audience: 'Advanced',
      participants: ['Priya Raman · Primary speaker', 'Marcus Okafor · Co-presenter'],
      status: 'Accepted',
    },
    {
      id: 'ABS-138',
      title: 'Your AI Pair Programmer Is Lying to You: Verification Patterns That Scale',
      abstract: 'Verification patterns for teams shipping AI-assisted code: property tests, mutation coverage, snapshot judges, and production-backed gates.',
      track: 'AI Engineering',
      format: 'Talk · 30m',
      takeaway: 'A practical verification ladder for AI-generated code.',
      audience: 'Intermediate',
      participants: ['Priya Raman · Primary speaker'],
      status: 'Rejected',
    },
    {
      id: 'ABS-131',
      title: 'Docs That Answer Back: Retrieval-Grounded Documentation Sites',
      abstract: 'Turn a static documentation site into one that answers questions with citations and stays honest when it does not know.',
      track: 'Developer Experience',
      format: 'Lightning · 10m',
      takeaway: 'A citation-first architecture for conversational docs.',
      audience: 'Intermediate',
      participants: ['Priya Raman · Primary speaker'],
      status: 'Submitted',
    },
  ],
  review: {
    originality: 4,
    relevance: 4,
    recommendation: 'Accept',
    comment: 'Strong practical content and a clear narrative arc; abstract could name the specific tooling used. Recommend accept for the Platform track.',
    submitted: true,
  },
  notification: 'not_sent',
  speaker: {
    bio: 'Priya Raman is a principal engineer at Latticework Systems focused on build infrastructure, developer productivity, and reliable delivery systems.',
    tasks: [
      { id: 'confirm', label: 'Confirm participation', done: true },
      { id: 'profile', label: 'Complete bio and profile', done: true },
      { id: 'release', label: 'Sign speaker release form', done: false },
      { id: 'headshot', label: 'Upload final headshot (print quality)', done: false },
    ],
    files: [
      { name: 'slides.pdf', version: 1, note: 'Initial deck · Apr 25' },
      { name: 'slides.pdf', version: 2, note: 'Revised diagrams · Apr 28' },
    ],
  },
  contentApproved: true,
  embedEnabled: true,
  programPublished: true,
}
