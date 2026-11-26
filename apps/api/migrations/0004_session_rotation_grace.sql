-- Refresh-token rotation grace window: two tabs (or a double page load) refreshing at the same time
-- must not log the user out. The previous token stays usable for a few seconds after rotation, for an
-- access token only (no new refresh token). Reuse after the window revokes the session (theft signal).
ALTER TABLE sessions ADD COLUMN previous_token_hash text;
ALTER TABLE sessions ADD COLUMN rotated_at timestamptz;
CREATE INDEX sessions_previous_hash_idx ON sessions(previous_token_hash) WHERE previous_token_hash IS NOT NULL;
