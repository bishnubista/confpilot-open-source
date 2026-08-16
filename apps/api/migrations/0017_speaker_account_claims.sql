CREATE TABLE speaker_claim_invitations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  speaker_id TEXT NOT NULL REFERENCES speakers(id) ON DELETE RESTRICT,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  revoked_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  outbox_message_id TEXT NOT NULL UNIQUE REFERENCES message_outbox(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  expired_at TEXT,
  UNIQUE (event_id, idempotency_key),
  CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 128),
  CHECK (expires_at > created_at AND updated_at >= created_at),
  CHECK (
    (state = 'pending' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND expired_at IS NULL)
    OR (state = 'accepted' AND accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND expired_at IS NULL)
    OR (state = 'revoked' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_by_user_id IS NOT NULL AND revoked_at IS NOT NULL AND expired_at IS NULL)
    OR (state = 'expired' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND expired_at = expires_at)
  )
);

CREATE UNIQUE INDEX speaker_claim_pending_speaker_unique
  ON speaker_claim_invitations(speaker_id) WHERE state = 'pending';
CREATE INDEX speaker_claim_event_created
  ON speaker_claim_invitations(event_id, created_at DESC, id DESC);

CREATE TABLE speaker_claim_acceptances (
  invitation_id TEXT PRIMARY KEY REFERENCES speaker_claim_invitations(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  speaker_id TEXT NOT NULL UNIQUE REFERENCES speakers(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at TEXT NOT NULL,
  UNIQUE (event_id, user_id)
);

CREATE TRIGGER speaker_claim_insert_guard
BEFORE INSERT ON speaker_claim_invitations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM event_memberships WHERE event_id = NEW.event_id
      AND user_id = NEW.invited_by_user_id AND role = 'organizer'
  ) THEN RAISE(ABORT, 'speaker claim requires same-event organizer') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM speakers WHERE id = NEW.speaker_id AND event_id = NEW.event_id
      AND user_id IS NULL AND lower(trim(contact_email)) = NEW.email
  ) THEN RAISE(ABORT, 'speaker claim target mismatch') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM users AS user INNER JOIN event_memberships AS membership
      ON membership.user_id = user.id AND membership.event_id = NEW.event_id
    WHERE lower(trim(user.email)) = NEW.email
  ) THEN RAISE(ABORT, 'speaker claim email already has event membership') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM message_outbox WHERE id = NEW.outbox_message_id
      AND event_id = NEW.event_id AND actor_user_id = NEW.invited_by_user_id
      AND intent = 'speaker_claim_invitation' AND recipient_email = NEW.email
      AND recipient_name = (SELECT name FROM speakers WHERE id = NEW.speaker_id)
      AND expires_at = NEW.expires_at AND canceled_at IS NULL
  ) THEN RAISE(ABORT, 'speaker claim outbox mismatch') END;
END;

CREATE TRIGGER speaker_claim_identity_immutable
BEFORE UPDATE ON speaker_claim_invitations
WHEN NEW.id != OLD.id OR NEW.event_id != OLD.event_id OR NEW.speaker_id != OLD.speaker_id
  OR NEW.email != OLD.email OR NEW.token_hash != OLD.token_hash
  OR NEW.idempotency_key != OLD.idempotency_key OR NEW.expires_at != OLD.expires_at
  OR NEW.invited_by_user_id != OLD.invited_by_user_id
  OR NEW.outbox_message_id != OLD.outbox_message_id OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'speaker claim identity is immutable');
END;

CREATE TRIGGER speaker_claim_transition_guard
BEFORE UPDATE ON speaker_claim_invitations
BEGIN
  SELECT CASE WHEN OLD.state != 'pending' OR NEW.state NOT IN ('accepted', 'revoked', 'expired')
    THEN RAISE(ABORT, 'invalid speaker claim transition') END;
  SELECT CASE WHEN NEW.updated_at < OLD.updated_at
    THEN RAISE(ABORT, 'speaker claim timestamp cannot move backward') END;
  SELECT CASE WHEN NEW.state = 'accepted' AND (
    NEW.accepted_at != NEW.updated_at
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.accepted_by_user_id AND lower(trim(email)) = NEW.email)
    OR NOT EXISTS (SELECT 1 FROM speakers WHERE id = NEW.speaker_id AND event_id = NEW.event_id
      AND user_id IS NULL AND lower(trim(contact_email)) = NEW.email)
    OR EXISTS (SELECT 1 FROM event_memberships WHERE event_id = NEW.event_id AND user_id = NEW.accepted_by_user_id)
  ) THEN RAISE(ABORT, 'speaker claim acceptance identity mismatch') END;
  SELECT CASE WHEN NEW.state = 'revoked' AND (
    NEW.revoked_at != NEW.updated_at OR NOT EXISTS (
      SELECT 1 FROM event_memberships WHERE event_id = NEW.event_id
        AND user_id = NEW.revoked_by_user_id AND role = 'organizer'
    )
  ) THEN RAISE(ABORT, 'speaker claim revocation requires same-event organizer') END;
  SELECT CASE WHEN NEW.state = 'expired' AND (NEW.expired_at != OLD.expires_at OR NEW.updated_at < OLD.expires_at)
    THEN RAISE(ABORT, 'speaker claim expiry is invalid') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM message_outbox WHERE id = NEW.outbox_message_id AND (
      state IN ('delivered', 'failed') OR (canceled_at IS NOT NULL AND cancellation_code = CASE NEW.state
        WHEN 'accepted' THEN 'INVITATION_ACCEPTED' WHEN 'revoked' THEN 'INVITATION_REVOKED'
        WHEN 'expired' THEN 'MESSAGE_EXPIRED' END)
    )
  ) THEN RAISE(ABORT, 'speaker claim outbox transition mismatch') END;
END;

CREATE TRIGGER speaker_claim_acceptance_insert_guard
BEFORE INSERT ON speaker_claim_acceptances
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM speaker_claim_invitations WHERE id = NEW.invitation_id
      AND event_id = NEW.event_id AND speaker_id = NEW.speaker_id
      AND state = 'accepted' AND accepted_by_user_id = NEW.user_id AND accepted_at = NEW.accepted_at
  ) THEN RAISE(ABORT, 'speaker claim acceptance receipt mismatch') END;
END;

CREATE TRIGGER speaker_claim_acceptance_immutable
BEFORE UPDATE ON speaker_claim_acceptances BEGIN
  SELECT RAISE(ABORT, 'speaker claim acceptance is immutable');
END;
CREATE TRIGGER speaker_claim_acceptance_no_delete
BEFORE DELETE ON speaker_claim_acceptances BEGIN
  SELECT RAISE(ABORT, 'speaker claim acceptance is immutable');
END;

CREATE TRIGGER speaker_claim_link_guard
BEFORE UPDATE OF user_id ON speakers
WHEN OLD.user_id IS NULL AND NEW.user_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM speaker_claim_acceptances WHERE event_id = NEW.event_id
      AND speaker_id = NEW.id AND user_id = NEW.user_id
  ) OR NOT EXISTS (
    SELECT 1 FROM event_memberships WHERE event_id = NEW.event_id
      AND user_id = NEW.user_id AND role = 'speaker'
  ) THEN RAISE(ABORT, 'speaker account link requires accepted same-event claim') END;
END;
