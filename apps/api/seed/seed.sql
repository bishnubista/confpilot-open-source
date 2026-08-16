INSERT INTO events (id, slug, name, tagline, location, description, starts_on, ends_on, cfp_deadline, status, time_zone) VALUES
  ('evt-devflow', 'devflow-conf-2027', 'DevFlow Conf 2027', 'The developer workflow conference', 'Moscone West, San Francisco, CA', 'A three-day, three-track conference on developer tooling, AI-assisted engineering, and platform infrastructure.', '2027-05-12', '2027-05-14', '2027-04-30T23:59:00Z', 'published', 'America/Los_Angeles'),
  ('evt-fieldnotes', 'field-notes-2027', 'Field Notes 2027', 'Build gatherings people remember', 'Oakland Convention Center, Oakland, CA', 'A practical gathering for independent organizers and program teams.', '2027-09-08', '2027-09-10', '2027-05-15T23:59:00Z', 'published', 'America/Los_Angeles');

INSERT INTO cfp_configs (event_id, status, opens_at, closes_at, confirmation_message, revision, created_at, updated_at) VALUES
  ('evt-devflow', 'published', '2026-08-01T00:00:00Z', '2027-04-30T23:59:00Z', 'Thanks for sharing your proposal. You can view its status from this account.', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
  ('evt-fieldnotes', 'published', '2026-08-01T00:00:00Z', '2027-05-15T23:59:00Z', 'Thanks for sharing your proposal. You can view its status from this account.', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');

INSERT INTO cfp_fields (id, event_id, field_key, section, field_type, label, help_text, required, options_json, sort_order, show_when_field_key, show_when_value, active) VALUES
  ('cfp-d-title', 'evt-devflow', 'title', 'session', 'short_text', 'Title', 'Make it clear and specific.', 1, '[]', 10, NULL, NULL, 1),
  ('cfp-d-abstract', 'evt-devflow', 'abstract', 'session', 'long_text', 'Abstract', 'Describe what attendees will learn.', 1, '[]', 20, NULL, NULL, 1),
  ('cfp-d-track', 'evt-devflow', 'track', 'session', 'dropdown', 'Track', '', 1, '[{"value":"AI Engineering","label":"AI Engineering"},{"value":"Platform & Infra","label":"Platform & Infra"},{"value":"Developer Experience","label":"Developer Experience"}]', 30, NULL, NULL, 1),
  ('cfp-d-format', 'evt-devflow', 'format', 'session', 'dropdown', 'Format', '', 1, '[{"value":"keynote","label":"Keynote (45 min)","durationMinutes":45},{"value":"talk","label":"Talk (30 min)","durationMinutes":30},{"value":"lightning","label":"Lightning Talk (10 min)","durationMinutes":10},{"value":"workshop","label":"Workshop (120 min)","durationMinutes":120},{"value":"panel","label":"Panel (45 min)","durationMinutes":45}]', 40, NULL, NULL, 1),
  ('cfp-d-bio', 'evt-devflow', 'speaker_bio', 'speaker', 'long_text', 'Speaker bio', '', 0, '[]', 50, NULL, NULL, 1),
  ('cfp-d-takeaway', 'evt-devflow', 'key_takeaway', 'session', 'short_text', 'Key takeaway', '', 1, '[]', 60, NULL, NULL, 1),
  ('cfp-d-level', 'evt-devflow', 'audience_level', 'session', 'dropdown', 'Audience level', '', 0, '[{"value":"Beginner","label":"Beginner"},{"value":"Intermediate","label":"Intermediate"},{"value":"Advanced","label":"Advanced"}]', 70, NULL, NULL, 1),
  ('cfp-d-prereqs', 'evt-devflow', 'workshop_prerequisites', 'session', 'long_text', 'Workshop prerequisites', '', 0, '[]', 80, 'format', 'workshop', 1),
  ('cfp-f-title', 'evt-fieldnotes', 'title', 'session', 'short_text', 'Title', '', 1, '[]', 10, NULL, NULL, 1),
  ('cfp-f-abstract', 'evt-fieldnotes', 'abstract', 'session', 'long_text', 'Abstract', '', 1, '[]', 20, NULL, NULL, 1),
  ('cfp-f-track', 'evt-fieldnotes', 'track', 'session', 'dropdown', 'Track', '', 1, '[{"value":"Programming","label":"Programming"},{"value":"Experience","label":"Experience"}]', 30, NULL, NULL, 1),
  ('cfp-f-format', 'evt-fieldnotes', 'format', 'session', 'dropdown', 'Format', '', 1, '[{"value":"talk","label":"Talk (30 min)","durationMinutes":30},{"value":"workshop","label":"Workshop (120 min)","durationMinutes":120}]', 40, NULL, NULL, 1);

INSERT INTO users (id, email, display_name, created_at) VALUES
  ('usr-devflow-organizer', 'organizer@devflow.example', 'Jordan Alvarez', '2026-08-10T00:00:00Z'),
  ('usr-devflow-reviewer', 'reviewer@devflow.example', 'Sam Whitfield', '2026-08-10T00:00:00Z'),
  ('usr-fieldnotes-organizer', 'organizer@fieldnotes.example', 'Morgan Lee', '2026-08-10T00:00:00Z'),
  ('usr-d-priya', 'priya@devflow.example', 'Priya Raman', '2026-08-10T00:00:00Z'),
  ('usr-d-marcus', 'marcus@devflow.example', 'Marcus Okafor', '2026-08-10T00:00:00Z'),
  ('usr-d-elena', 'elena@devflow.example', 'Elena Torres', '2026-08-10T00:00:00Z'),
  ('usr-d-maya', 'maya@devflow.example', 'Maya Chen', '2026-08-10T00:00:00Z'),
  ('usr-d-amara', 'amara@devflow.example', 'Amara Okafor', '2026-08-10T00:00:00Z'),
  ('usr-d-jules', 'jules@devflow.example', 'Jules Park', '2026-08-10T00:00:00Z'),
  ('usr-d-theo', 'theo@devflow.example', 'Theo Martins', '2026-08-10T00:00:00Z'),
  ('usr-d-sanaa', 'sanaa@devflow.example', 'Sanaa Idris', '2026-08-10T00:00:00Z'),
  ('usr-f-lina', 'lina@fieldnotes.example', 'Lina Haddad', '2026-08-10T00:00:00Z'),
  ('usr-f-diego', 'diego@fieldnotes.example', 'Diego Alvarez', '2026-08-10T00:00:00Z');

INSERT INTO event_memberships (id, event_id, user_id, role, created_at) VALUES
  ('mem-devflow-organizer', 'evt-devflow', 'usr-devflow-organizer', 'organizer', '2026-08-10T00:00:00Z'),
  ('mem-devflow-reviewer', 'evt-devflow', 'usr-devflow-reviewer', 'reviewer', '2026-08-10T00:00:00Z'),
  ('mem-fieldnotes-organizer', 'evt-fieldnotes', 'usr-fieldnotes-organizer', 'organizer', '2026-08-10T00:00:00Z'),
  ('mem-d-priya', 'evt-devflow', 'usr-d-priya', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-d-marcus', 'evt-devflow', 'usr-d-marcus', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-d-elena', 'evt-devflow', 'usr-d-elena', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-d-maya', 'evt-devflow', 'usr-d-maya', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-d-amara', 'evt-devflow', 'usr-d-amara', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-d-jules', 'evt-devflow', 'usr-d-jules', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-d-theo', 'evt-devflow', 'usr-d-theo', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-d-sanaa', 'evt-devflow', 'usr-d-sanaa', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-f-lina', 'evt-fieldnotes', 'usr-f-lina', 'speaker', '2026-08-10T00:00:00Z'),
  ('mem-f-diego', 'evt-fieldnotes', 'usr-f-diego', 'speaker', '2026-08-10T00:00:00Z');

INSERT INTO event_days (id, event_id, day_number, date, label) VALUES
  ('day-d-1', 'evt-devflow', 1, '2027-05-12', 'Day 1'),
  ('day-d-2', 'evt-devflow', 2, '2027-05-13', 'Day 2'),
  ('day-d-3', 'evt-devflow', 3, '2027-05-14', 'Day 3'),
  ('day-f-1', 'evt-fieldnotes', 1, '2027-09-08', 'Day 1'),
  ('day-f-2', 'evt-fieldnotes', 2, '2027-09-09', 'Day 2'),
  ('day-f-3', 'evt-fieldnotes', 3, '2027-09-10', 'Day 3');

INSERT INTO rooms (id, event_id, name, capacity, sort_order) VALUES
  ('room-d-main', 'evt-devflow', 'Main Stage', 800, 1),
  ('room-d-2a', 'evt-devflow', 'Room 2A', 260, 2),
  ('room-d-2b', 'evt-devflow', 'Room 2B', 220, 3),
  ('room-d-workshop', 'evt-devflow', 'Workshop Lab', 96, 4),
  ('room-f-horizon', 'evt-fieldnotes', 'Horizon Hall', 360, 1),
  ('room-f-atlas', 'evt-fieldnotes', 'Atlas Room', 180, 2),
  ('room-f-foundry', 'evt-fieldnotes', 'Foundry Studio', 100, 3),
  ('room-f-garden', 'evt-fieldnotes', 'Garden Lab', 64, 4);

INSERT INTO speakers (id, event_id, user_id, slug, name, title, company, bio, headshot_url, headshot_fallback, profile_status, agreement_status, public_visibility) VALUES
  ('spk-d-priya', 'evt-devflow', 'usr-d-priya', 'priya-raman', 'Priya Raman', 'Principal Engineer', 'Latticework Systems', 'Priya leads the build-tooling platform team at Latticework Systems and previously maintained the open-source task runner gantry.', NULL, 'PR', 'ready', 'signed', 'published'),
  ('spk-d-marcus', 'evt-devflow', 'usr-d-marcus', 'marcus-okafor', 'Marcus Okafor', 'Staff Developer Advocate', 'Cloudreach Labs', 'Marcus focuses on AI agents in production, writes Agents Weekly, and co-organizes the SF AI Tinkerers meetup.', NULL, 'MO', 'ready', 'signed', 'published'),
  ('spk-d-elena', 'evt-devflow', 'usr-d-elena', 'elena-torres', 'Elena Torres', 'Director of Developer Experience', 'Northstar', 'Elena builds documentation and learning systems that make complex platforms approachable.', NULL, 'ET', 'ready', 'signed', 'published'),
  ('spk-d-maya', 'evt-devflow', 'usr-d-maya', 'maya-chen', 'Maya Chen', 'Staff Platform Engineer', 'Relay', 'Maya builds infrastructure that makes safe delivery the default for fast-moving product teams.', NULL, 'MC', 'ready', 'signed', 'published'),
  ('spk-d-amara', 'evt-devflow', 'usr-d-amara', 'amara-okafor', 'Amara Okafor', 'VP Engineering', 'Parallel Works', 'Amara helps product teams turn operational constraints into durable engineering systems.', NULL, 'AO', 'ready', 'signed', 'published'),
  ('spk-d-jules', 'evt-devflow', 'usr-d-jules', 'jules-park', 'Jules Park', 'Open Source Program Lead', 'Mosaic', 'Jules designs healthy participation systems for large technical communities.', NULL, 'JP', 'ready', 'signed', 'published'),
  ('spk-d-theo', 'evt-devflow', 'usr-d-theo', 'theo-martins', 'Theo Martins', 'Independent Product Strategist', 'Independent', 'Theo studies how small teams make high-quality product decisions with incomplete evidence.', NULL, 'TM', 'incomplete', 'signed', 'published'),
  ('spk-d-sanaa', 'evt-devflow', 'usr-d-sanaa', 'sanaa-idris', 'Sanaa Idris', 'AI Reliability Engineer', 'Kinship', 'Sanaa develops evaluation and observability practices for production AI systems.', NULL, 'SI', 'ready', 'signed', 'published'),
  ('spk-f-lina', 'evt-fieldnotes', 'usr-f-lina', 'lina-haddad', 'Lina Haddad', 'Conference Producer', 'Independent', 'Lina produces thoughtful gatherings across three continents.', NULL, 'LH', 'ready', 'signed', 'published'),
  ('spk-f-diego', 'evt-fieldnotes', 'usr-f-diego', 'diego-alvarez', 'Diego Alvarez', 'Accessibility Researcher', 'Open Access Lab', 'Diego works with event teams to design inclusive experiences.', NULL, 'DA', 'ready', 'signed', 'published');

INSERT INTO proposals (id, event_id, owner_user_id, public_id, slug, title, abstract, track, format, duration_minutes, status, submitted_at, created_at, updated_at) VALUES
  ('prop-d-1', 'evt-devflow', 'usr-d-amara', 'ABS-101', 'workflows-that-explain-themselves', 'Workflows That Explain Themselves', 'A practical keynote on engineering systems that reveal their own state, decisions, and recovery paths.', 'Developer Experience', 'keynote', 45, 'decided', '2027-01-10T18:00:00Z', '2027-01-10T18:00:00Z', '2027-02-18T18:00:00Z'),
  ('prop-d-2', 'evt-devflow', 'usr-d-priya', 'ABS-142', 'taming-40-minute-ci', 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale', 'Our monorepo CI took 40 minutes on a good day. Learn how content-addressed caching, remote execution, and test selection cut it to six.', 'Platform & Infra', 'talk', 30, 'decided', '2027-01-11T18:00:00Z', '2027-01-11T18:00:00Z', '2027-02-18T18:05:00Z'),
  ('prop-d-3', 'evt-devflow', 'usr-d-priya', 'ABS-138', 'ai-pair-programmer-verification', 'Your AI Pair Programmer Is Lying to You: Verification Patterns That Scale', 'Code generation is easy; trusting it is hard. Explore property tests, mutation coverage, snapshot judges, and CI gates backed by production data.', 'AI Engineering', 'talk', 30, 'decided', '2027-01-12T18:00:00Z', '2027-01-12T18:00:00Z', '2027-02-18T18:10:00Z'),
  ('prop-d-4', 'evt-devflow', 'usr-d-priya', 'ABS-131', 'docs-that-answer-back', 'Docs That Answer Back: Retrieval-Grounded Documentation Sites', 'Turn a static docs site into one that answers questions with citations, stays honest when it does not know, and remains affordable.', 'Developer Experience', 'lightning', 10, 'decided', '2027-01-13T18:00:00Z', '2027-01-13T18:00:00Z', '2027-02-18T18:15:00Z'),
  ('prop-d-5', 'evt-devflow', 'usr-d-maya', 'ABS-127', 'boring-path-to-reliability', 'The Boring Path to Platform Reliability', 'Practical platform patterns that make safe and reliable delivery repeatable.', 'Platform & Infra', 'talk', 30, 'decided', '2027-01-14T18:00:00Z', '2027-01-14T18:00:00Z', '2027-02-18T18:20:00Z'),
  ('prop-d-6', 'evt-devflow', 'usr-d-sanaa', 'ABS-119', 'evals-you-can-trust', 'Evals You Can Trust', 'Build a hands-on evaluation harness for AI features with representative fixtures, failure analysis, and release gates.', 'AI Engineering', 'workshop', 120, 'decided', '2027-01-15T18:00:00Z', '2027-01-15T18:00:00Z', '2027-02-18T18:25:00Z'),
  ('prop-d-7', 'evt-devflow', 'usr-d-jules', 'ABS-114', 'maintainers-at-scale', 'Maintainers at Scale', 'A panel on sustainable contribution, governance, and recognition across open-source ecosystems.', 'Developer Experience', 'panel', 45, 'decided', '2027-01-16T18:00:00Z', '2027-01-16T18:00:00Z', '2027-02-18T18:30:00Z'),
  ('prop-d-8', 'evt-devflow', 'usr-d-theo', 'ABS-108', 'decisions-under-constraint', 'Decisions Under Constraint', 'A decision framework for teams balancing developer velocity, reliability, and limited platform capacity.', 'Platform & Infra', 'talk', 30, 'decided', '2027-01-17T18:00:00Z', '2027-01-17T18:00:00Z', '2027-02-18T18:35:00Z'),
  ('prop-f-1', 'evt-fieldnotes', 'usr-f-lina', 'ABS-201', 'programs-with-a-point-of-view', 'Programs With a Point of View', 'Shape a coherent program without flattening the voices inside it.', 'Programming', 'talk', 40, 'decided', '2027-05-01T18:00:00Z', '2027-05-01T18:00:00Z', '2027-06-10T18:00:00Z'),
  ('prop-f-2', 'evt-fieldnotes', 'usr-f-diego', 'ABS-202', 'access-is-an-operating-system', 'Access Is an Operating System', 'Treat accessibility as an end-to-end event practice instead of a checklist.', 'Experience', 'workshop', 60, 'decided', '2027-05-02T18:00:00Z', '2027-05-02T18:00:00Z', '2027-06-10T18:05:00Z'),
  ('prop-d-supplemental-submitted', 'evt-devflow', 'usr-d-elena', 'ABS-151', 'maintainable-developer-portals', 'Maintainable Developer Portals', 'A supplemental seed proposal that keeps the fresh database decision workflow exercisable.', 'Developer Experience', 'talk', 30, 'submitted', '2027-02-19T17:00:00Z', '2027-02-19T17:00:00Z', '2027-02-19T17:00:00Z'),
  ('prop-d-supplemental-review', 'evt-devflow', 'usr-d-marcus', 'ABS-152', 'operationalizing-agent-evals', 'Operationalizing Agent Evals', 'A supplemental seed proposal with an active reviewer assignment for end-to-end workflow testing.', 'AI Engineering', 'talk', 30, 'in_review', '2027-02-19T17:05:00Z', '2027-02-19T17:05:00Z', '2027-02-19T17:10:00Z');

INSERT INTO proposal_presenters (id, event_id, proposal_id, speaker_id, role) VALUES
  ('pp-d-1-primary', 'evt-devflow', 'prop-d-1', 'spk-d-amara', 'primary'),
  ('pp-d-2-primary', 'evt-devflow', 'prop-d-2', 'spk-d-priya', 'primary'),
  ('pp-d-2-marcus', 'evt-devflow', 'prop-d-2', 'spk-d-marcus', 'co_presenter'),
  ('pp-d-3-primary', 'evt-devflow', 'prop-d-3', 'spk-d-priya', 'primary'),
  ('pp-d-4-primary', 'evt-devflow', 'prop-d-4', 'spk-d-priya', 'primary'),
  ('pp-d-5-primary', 'evt-devflow', 'prop-d-5', 'spk-d-maya', 'primary'),
  ('pp-d-6-primary', 'evt-devflow', 'prop-d-6', 'spk-d-sanaa', 'primary'),
  ('pp-d-7-primary', 'evt-devflow', 'prop-d-7', 'spk-d-jules', 'primary'),
  ('pp-d-8-primary', 'evt-devflow', 'prop-d-8', 'spk-d-theo', 'primary'),
  ('pp-f-1-primary', 'evt-fieldnotes', 'prop-f-1', 'spk-f-lina', 'primary'),
  ('pp-f-2-primary', 'evt-fieldnotes', 'prop-f-2', 'spk-f-diego', 'primary'),
  ('pp-d-supplemental-submitted', 'evt-devflow', 'prop-d-supplemental-submitted', 'spk-d-elena', 'primary'),
  ('pp-d-supplemental-review', 'evt-devflow', 'prop-d-supplemental-review', 'spk-d-marcus', 'primary');

INSERT INTO review_assignments (
  id, event_id, proposal_id, reviewer_user_id, created_by_user_id, round, blind,
  state, due_at, revoked_at, revoked_by_user_id, created_at, updated_at
) VALUES (
  'assignment-d-supplemental-review', 'evt-devflow', 'prop-d-supplemental-review',
  'usr-devflow-reviewer', 'usr-devflow-organizer', 1, 1, 'assigned',
  '2027-02-26T18:00:00Z', NULL, NULL, '2027-02-19T17:10:00Z', '2027-02-19T17:10:00Z'
);

INSERT INTO decisions (id, event_id, proposal_id, decision, rationale, decided_by_user_id, decided_at) VALUES
  ('dec-d-1', 'evt-devflow', 'prop-d-1', 'accept', 'Strong opening perspective and clear audience value.', 'usr-devflow-organizer', '2027-02-18T18:00:00Z'),
  ('dec-d-2', 'evt-devflow', 'prop-d-2', 'accept', 'Concrete platform lessons with credible migration evidence.', 'usr-devflow-organizer', '2027-02-18T18:05:00Z'),
  ('dec-d-3', 'evt-devflow', 'prop-d-3', 'accept', 'Timely advanced material with practical verification patterns.', 'usr-devflow-organizer', '2027-02-18T18:10:00Z'),
  ('dec-d-4', 'evt-devflow', 'prop-d-4', 'accept', 'Focused lightning talk with a clear attendee takeaway.', 'usr-devflow-organizer', '2027-02-18T18:15:00Z'),
  ('dec-d-5', 'evt-devflow', 'prop-d-5', 'accept', 'Strong fit for the platform track.', 'usr-devflow-organizer', '2027-02-18T18:20:00Z'),
  ('dec-d-6', 'evt-devflow', 'prop-d-6', 'accept', 'Hands-on format adds depth to the AI track.', 'usr-devflow-organizer', '2027-02-18T18:25:00Z'),
  ('dec-d-7', 'evt-devflow', 'prop-d-7', 'accept', 'Distinct open-source operations perspective.', 'usr-devflow-organizer', '2027-02-18T18:30:00Z'),
  ('dec-d-8', 'evt-devflow', 'prop-d-8', 'accept', 'Useful decision framework for infrastructure leaders.', 'usr-devflow-organizer', '2027-02-18T18:35:00Z'),
  ('dec-f-1', 'evt-fieldnotes', 'prop-f-1', 'accept', 'Clear fit for the editorial program.', 'usr-fieldnotes-organizer', '2027-06-10T18:00:00Z'),
  ('dec-f-2', 'evt-fieldnotes', 'prop-f-2', 'accept', 'Important and practical event guidance.', 'usr-fieldnotes-organizer', '2027-06-10T18:05:00Z');

INSERT INTO program_sessions (id, event_id, source_proposal_id, slug, title, abstract, track, format, duration_minutes, publication_status, deliverables_status, approval_status, created_at, updated_at) VALUES
  ('ses-d-1', 'evt-devflow', 'prop-d-1', 'workflows-that-explain-themselves', 'Workflows That Explain Themselves', 'A practical keynote on engineering systems that reveal their own state, decisions, and recovery paths.', 'Developer Experience', 'keynote', 45, 'published', 'ready', 'approved', '2027-02-18T18:00:00Z', '2027-04-18T21:14:00Z'),
  ('ses-d-2', 'evt-devflow', 'prop-d-2', 'taming-40-minute-ci', 'Taming 40-Minute CI: Incremental Builds at Monorepo Scale', 'Our monorepo CI took 40 minutes on a good day. Learn how content-addressed caching, remote execution, and test selection cut it to six.', 'Platform & Infra', 'talk', 30, 'published', 'ready', 'approved', '2027-02-18T18:05:00Z', '2027-04-18T21:14:00Z'),
  ('ses-d-3', 'evt-devflow', 'prop-d-3', 'ai-pair-programmer-verification', 'Your AI Pair Programmer Is Lying to You: Verification Patterns That Scale', 'Code generation is easy; trusting it is hard. Explore property tests, mutation coverage, snapshot judges, and CI gates backed by production data.', 'AI Engineering', 'talk', 30, 'published', 'ready', 'approved', '2027-02-18T18:10:00Z', '2027-04-18T21:14:00Z'),
  ('ses-d-4', 'evt-devflow', 'prop-d-4', 'docs-that-answer-back', 'Docs That Answer Back: Retrieval-Grounded Documentation Sites', 'Turn a static docs site into one that answers questions with citations, stays honest when it does not know, and remains affordable.', 'Developer Experience', 'lightning', 10, 'published', 'ready', 'approved', '2027-02-18T18:15:00Z', '2027-04-18T21:14:00Z'),
  ('ses-d-5', 'evt-devflow', 'prop-d-5', 'boring-path-to-reliability', 'The Boring Path to Platform Reliability', 'Practical platform patterns that make safe and reliable delivery repeatable.', 'Platform & Infra', 'talk', 30, 'published', 'ready', 'approved', '2027-02-18T18:20:00Z', '2027-04-18T21:14:00Z'),
  ('ses-d-6', 'evt-devflow', 'prop-d-6', 'evals-you-can-trust', 'Evals You Can Trust', 'Build a hands-on evaluation harness for AI features with representative fixtures, failure analysis, and release gates.', 'AI Engineering', 'workshop', 120, 'published', 'ready', 'changes_requested', '2027-02-18T18:25:00Z', '2027-04-18T21:14:00Z'),
  ('ses-d-7', 'evt-devflow', 'prop-d-7', 'maintainers-at-scale', 'Maintainers at Scale', 'A panel on sustainable contribution, governance, and recognition across open-source ecosystems.', 'Developer Experience', 'panel', 45, 'ready', 'submitted', 'pending', '2027-02-18T18:30:00Z', '2027-04-18T21:14:00Z'),
  ('ses-d-8', 'evt-devflow', 'prop-d-8', 'decisions-under-constraint', 'Decisions Under Constraint', 'A decision framework for teams balancing developer velocity, reliability, and limited platform capacity.', 'Platform & Infra', 'talk', 30, 'published', 'missing', 'approved', '2027-02-18T18:35:00Z', '2027-04-18T21:14:00Z'),
  ('ses-f-1', 'evt-fieldnotes', 'prop-f-1', 'programs-with-a-point-of-view', 'Programs With a Point of View', 'Shape a coherent program without flattening the voices inside it.', 'Programming', 'talk', 40, 'published', 'ready', 'approved', '2027-06-10T18:00:00Z', '2027-08-20T18:00:00Z'),
  ('ses-f-2', 'evt-fieldnotes', 'prop-f-2', 'access-is-an-operating-system', 'Access Is an Operating System', 'Treat accessibility as an end-to-end event practice instead of a checklist.', 'Experience', 'workshop', 60, 'private', 'submitted', 'pending', '2027-06-10T18:05:00Z', '2027-08-20T18:00:00Z');

INSERT INTO acceptances (id, event_id, proposal_id, decision_id, program_session_id, accepted_by_user_id, idempotency_key, accepted_at) VALUES
  ('acc-d-1', 'evt-devflow', 'prop-d-1', 'dec-d-1', 'ses-d-1', 'usr-devflow-organizer', 'seed:dec-d-1', '2027-02-18T18:00:00Z'),
  ('acc-d-2', 'evt-devflow', 'prop-d-2', 'dec-d-2', 'ses-d-2', 'usr-devflow-organizer', 'seed:dec-d-2', '2027-02-18T18:05:00Z'),
  ('acc-d-3', 'evt-devflow', 'prop-d-3', 'dec-d-3', 'ses-d-3', 'usr-devflow-organizer', 'seed:dec-d-3', '2027-02-18T18:10:00Z'),
  ('acc-d-4', 'evt-devflow', 'prop-d-4', 'dec-d-4', 'ses-d-4', 'usr-devflow-organizer', 'seed:dec-d-4', '2027-02-18T18:15:00Z'),
  ('acc-d-5', 'evt-devflow', 'prop-d-5', 'dec-d-5', 'ses-d-5', 'usr-devflow-organizer', 'seed:dec-d-5', '2027-02-18T18:20:00Z'),
  ('acc-d-6', 'evt-devflow', 'prop-d-6', 'dec-d-6', 'ses-d-6', 'usr-devflow-organizer', 'seed:dec-d-6', '2027-02-18T18:25:00Z'),
  ('acc-d-7', 'evt-devflow', 'prop-d-7', 'dec-d-7', 'ses-d-7', 'usr-devflow-organizer', 'seed:dec-d-7', '2027-02-18T18:30:00Z'),
  ('acc-d-8', 'evt-devflow', 'prop-d-8', 'dec-d-8', 'ses-d-8', 'usr-devflow-organizer', 'seed:dec-d-8', '2027-02-18T18:35:00Z'),
  ('acc-f-1', 'evt-fieldnotes', 'prop-f-1', 'dec-f-1', 'ses-f-1', 'usr-fieldnotes-organizer', 'seed:dec-f-1', '2027-06-10T18:00:00Z'),
  ('acc-f-2', 'evt-fieldnotes', 'prop-f-2', 'dec-f-2', 'ses-f-2', 'usr-fieldnotes-organizer', 'seed:dec-f-2', '2027-06-10T18:05:00Z');

INSERT INTO session_presenters (id, event_id, program_session_id, speaker_id, role) VALUES
  ('presenter-d-1-primary', 'evt-devflow', 'ses-d-1', 'spk-d-amara', 'primary'),
  ('presenter-d-2-primary', 'evt-devflow', 'ses-d-2', 'spk-d-priya', 'primary'),
  ('presenter-d-2-marcus', 'evt-devflow', 'ses-d-2', 'spk-d-marcus', 'co_presenter'),
  ('presenter-d-3-primary', 'evt-devflow', 'ses-d-3', 'spk-d-priya', 'primary'),
  ('presenter-d-4-primary', 'evt-devflow', 'ses-d-4', 'spk-d-priya', 'primary'),
  ('presenter-d-5-primary', 'evt-devflow', 'ses-d-5', 'spk-d-maya', 'primary'),
  ('presenter-d-6-primary', 'evt-devflow', 'ses-d-6', 'spk-d-sanaa', 'primary'),
  ('presenter-d-7-primary', 'evt-devflow', 'ses-d-7', 'spk-d-jules', 'primary'),
  ('presenter-d-8-primary', 'evt-devflow', 'ses-d-8', 'spk-d-theo', 'primary'),
  ('presenter-f-1-primary', 'evt-fieldnotes', 'ses-f-1', 'spk-f-lina', 'primary'),
  ('presenter-f-2-primary', 'evt-fieldnotes', 'ses-f-2', 'spk-f-diego', 'primary');

INSERT INTO speaker_tasks (id, event_id, acceptance_id, program_session_id, speaker_id, task_key, label, state, created_at, completed_at)
SELECT
  'task:' || presenter.id || ':' || definition.task_key,
  presenter.event_id,
  acceptance.id,
  presenter.program_session_id,
  presenter.speaker_id,
  definition.task_key,
  definition.label,
  CASE WHEN session.approval_status = 'approved' THEN 'complete' ELSE 'open' END,
  acceptance.accepted_at,
  CASE WHEN session.approval_status = 'approved' THEN acceptance.accepted_at ELSE NULL END
FROM session_presenters presenter
INNER JOIN acceptances acceptance
  ON acceptance.event_id = presenter.event_id
  AND acceptance.program_session_id = presenter.program_session_id
INNER JOIN program_sessions session
  ON session.event_id = presenter.event_id
  AND session.id = presenter.program_session_id
CROSS JOIN (
  SELECT 'confirm' AS task_key, 'Confirm participation' AS label
  UNION ALL SELECT 'profile', 'Complete bio and profile'
  UNION ALL SELECT 'release', 'Sign speaker release form'
  UNION ALL SELECT 'headshot', 'Upload final headshot'
) definition;

INSERT INTO notification_outbox (
  id, event_id, decision_id, acceptance_id, recipient_speaker_id,
  recipient_user_id, recipient_name, recipient_email, queued_by_user_id,
  subject, body, state, queued_at, sent_at, failure_message
) VALUES
  ('note-d-1', 'evt-devflow', 'dec-d-1', 'acc-d-1', 'spk-d-amara', 'usr-d-amara', 'Amara Okafor', 'amara@devflow.example', 'usr-devflow-organizer', 'Your talk has been accepted to DevFlow Conf 2027', 'We are pleased to accept your proposal for DevFlow Conf 2027.', 'sent', '2027-02-18T18:01:00Z', '2027-02-18T18:02:00Z', NULL),
  ('note-d-2', 'evt-devflow', 'dec-d-2', 'acc-d-2', 'spk-d-priya', 'usr-d-priya', 'Priya Raman', 'priya@devflow.example', 'usr-devflow-organizer', 'Your talk has been accepted to DevFlow Conf 2027', 'We are pleased to accept your proposal for DevFlow Conf 2027.', 'sent', '2027-02-18T18:06:00Z', '2027-02-18T18:07:00Z', NULL),
  ('note-d-3', 'evt-devflow', 'dec-d-3', 'acc-d-3', 'spk-d-priya', 'usr-d-priya', 'Priya Raman', 'priya@devflow.example', 'usr-devflow-organizer', 'Your talk has been accepted to DevFlow Conf 2027', 'We are pleased to accept your proposal for DevFlow Conf 2027.', 'sent', '2027-02-18T18:11:00Z', '2027-02-18T18:12:00Z', NULL),
  ('note-d-4', 'evt-devflow', 'dec-d-4', 'acc-d-4', 'spk-d-priya', 'usr-d-priya', 'Priya Raman', 'priya@devflow.example', 'usr-devflow-organizer', 'Your talk has been accepted to DevFlow Conf 2027', 'We are pleased to accept your proposal for DevFlow Conf 2027.', 'pending', '2027-02-18T18:16:00Z', NULL, NULL),
  ('note-d-5', 'evt-devflow', 'dec-d-5', 'acc-d-5', 'spk-d-maya', 'usr-d-maya', 'Maya Chen', 'maya@devflow.example', 'usr-devflow-organizer', 'Your talk has been accepted to DevFlow Conf 2027', 'We are pleased to accept your proposal for DevFlow Conf 2027.', 'sent', '2027-02-18T18:21:00Z', '2027-02-18T18:22:00Z', NULL),
  ('note-d-6', 'evt-devflow', 'dec-d-6', 'acc-d-6', 'spk-d-sanaa', 'usr-d-sanaa', 'Sanaa Idris', 'sanaa@devflow.example', 'usr-devflow-organizer', 'Your talk has been accepted to DevFlow Conf 2027', 'We are pleased to accept your proposal for DevFlow Conf 2027.', 'sent', '2027-02-18T18:26:00Z', '2027-02-18T18:27:00Z', NULL),
  ('note-d-7', 'evt-devflow', 'dec-d-7', 'acc-d-7', 'spk-d-jules', 'usr-d-jules', 'Jules Park', 'jules@devflow.example', 'usr-devflow-organizer', 'Your talk has been accepted to DevFlow Conf 2027', 'We are pleased to accept your proposal for DevFlow Conf 2027.', 'sent', '2027-02-18T18:31:00Z', '2027-02-18T18:32:00Z', NULL),
  ('note-d-8', 'evt-devflow', 'dec-d-8', 'acc-d-8', 'spk-d-theo', 'usr-d-theo', 'Theo Martins', 'theo@devflow.example', 'usr-devflow-organizer', 'Your talk has been accepted to DevFlow Conf 2027', 'We are pleased to accept your proposal for DevFlow Conf 2027.', 'sent', '2027-02-18T18:36:00Z', '2027-02-18T18:37:00Z', NULL),
  ('note-f-1', 'evt-fieldnotes', 'dec-f-1', 'acc-f-1', 'spk-f-lina', 'usr-f-lina', 'Lina Haddad', 'lina@fieldnotes.example', 'usr-fieldnotes-organizer', 'Your talk has been accepted to Field Notes 2027', 'We are pleased to accept your proposal for Field Notes 2027.', 'sent', '2027-06-10T18:01:00Z', '2027-06-10T18:02:00Z', NULL),
  ('note-f-2', 'evt-fieldnotes', 'dec-f-2', 'acc-f-2', 'spk-f-diego', 'usr-f-diego', 'Diego Alvarez', 'diego@fieldnotes.example', 'usr-fieldnotes-organizer', 'Your talk has been accepted to Field Notes 2027', 'We are pleased to accept your proposal for Field Notes 2027.', 'pending', '2027-06-10T18:06:00Z', NULL, NULL);

INSERT INTO schedule_placements (id, event_id, program_session_id, event_day_id, room_id, starts_at, ends_at) VALUES
  ('plc-d-1', 'evt-devflow', 'ses-d-1', 'day-d-1', 'room-d-main', '2027-05-12T16:00:00Z', '2027-05-12T16:45:00Z'),
  ('plc-d-2', 'evt-devflow', 'ses-d-2', 'day-d-1', 'room-d-2a', '2027-05-12T17:15:00Z', '2027-05-12T17:45:00Z'),
  ('plc-d-3', 'evt-devflow', 'ses-d-3', 'day-d-1', 'room-d-2b', '2027-05-12T18:15:00Z', '2027-05-12T18:45:00Z'),
  ('plc-d-4', 'evt-devflow', 'ses-d-4', 'day-d-2', 'room-d-main', '2027-05-13T16:30:00Z', '2027-05-13T16:40:00Z'),
  ('plc-d-5', 'evt-devflow', 'ses-d-5', 'day-d-2', 'room-d-2a', '2027-05-13T17:00:00Z', '2027-05-13T17:30:00Z'),
  ('plc-d-6', 'evt-devflow', 'ses-d-6', 'day-d-2', 'room-d-workshop', '2027-05-13T20:00:00Z', '2027-05-13T22:00:00Z'),
  ('plc-d-7', 'evt-devflow', 'ses-d-7', 'day-d-3', 'room-d-main', '2027-05-14T17:00:00Z', '2027-05-14T17:45:00Z'),
  ('plc-d-8', 'evt-devflow', 'ses-d-8', 'day-d-3', 'room-d-2b', '2027-05-14T20:30:00Z', '2027-05-14T21:00:00Z'),
  ('plc-f-1', 'evt-fieldnotes', 'ses-f-1', 'day-f-1', 'room-f-horizon', '2027-09-08T16:30:00Z', '2027-09-08T17:10:00Z'),
  ('plc-f-2', 'evt-fieldnotes', 'ses-f-2', 'day-f-2', 'room-f-atlas', '2027-09-09T17:30:00Z', '2027-09-09T18:30:00Z');

INSERT INTO public_embed_configs (
  id, event_id, slug, name, view, filters_json, enabled, revision,
  created_by_user_id, updated_by_user_id, created_at, updated_at
) VALUES
  (
    'embed-d-homepage-agenda', 'evt-devflow', 'homepage-agenda', 'Homepage agenda', 'agenda',
    '{"days":[],"tracks":[],"formats":[],"rooms":[]}', 1, 1,
    'usr-devflow-organizer', 'usr-devflow-organizer',
    '2027-02-20T18:00:00Z', '2027-02-20T18:00:00Z'
  ),
  (
    'embed-f-speaker-gallery', 'evt-fieldnotes', 'speaker-gallery', 'Speaker gallery', 'gallery',
    '{"days":[],"tracks":[],"formats":[],"rooms":[]}', 0, 1,
    'usr-fieldnotes-organizer', 'usr-fieldnotes-organizer',
    '2027-06-12T18:00:00Z', '2027-06-12T18:00:00Z'
  );
