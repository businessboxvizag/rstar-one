-- RSTAR ONE · Milestone 1 · Clients, channels, Content ID sequences, content lifecycle core,
-- notifications. CRM detail (contacts, contracts, retainers) arrives in the CRM milestone.

CREATE TABLE clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id    uuid NOT NULL REFERENCES organisations(id),
  name               text NOT NULL,
  legal_name         text,
  industry           text,
  website            text,
  gstin              text,
  account_manager_id uuid REFERENCES users(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('prospect','active','paused','churned')),
  is_demo            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_by         uuid REFERENCES users(id),
  archived_at        timestamptz,
  UNIQUE (organisation_id, name)
);
CREATE TRIGGER clients_touch BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
ALTER TABLE users ADD CONSTRAINT users_client_fk FOREIGN KEY (client_id) REFERENCES clients(id);

CREATE TABLE channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  name            text NOT NULL,
  brand           text NOT NULL DEFAULT 'RSTAR',
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

-- One sequence per client or channel (or project later). Prefix is editable,
-- but every issued code is also protected by content_items' unique constraint,
-- and retired prefixes are kept in content_prefix_history so they are never re-issued.
CREATE TABLE content_sequences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  client_id       uuid REFERENCES clients(id),
  channel_id      uuid REFERENCES channels(id),
  prefix          text NOT NULL CHECK (prefix ~ '^[A-Z]{2,8}$'),
  segment_mode    text NOT NULL DEFAULT 'none' CHECK (segment_mode IN ('none','year','campaign')),
  padding         int NOT NULL DEFAULT 3 CHECK (padding BETWEEN 3 AND 6),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((client_id IS NULL) <> (channel_id IS NULL)),
  UNIQUE (organisation_id, prefix)
);
CREATE UNIQUE INDEX content_sequences_client_uq ON content_sequences(client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX content_sequences_channel_uq ON content_sequences(channel_id) WHERE channel_id IS NOT NULL;

CREATE TABLE content_prefix_history (
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  prefix          text NOT NULL,
  sequence_id     uuid NOT NULL REFERENCES content_sequences(id),
  retired_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, prefix)
);

-- Counter rows are the concurrency control point: allocation is a single
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING executed in the same
-- transaction as the content_items insert (row lock serialises writers).
CREATE TABLE content_sequence_counters (
  sequence_id uuid NOT NULL REFERENCES content_sequences(id),
  segment     text NOT NULL DEFAULT '',     -- '' when segment_mode = none; '2026' or campaign code otherwise
  last_value  bigint NOT NULL CHECK (last_value >= 1),
  PRIMARY KEY (sequence_id, segment)
);

CREATE TABLE content_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES organisations(id),
  content_code             text NOT NULL,
  sequence_id              uuid NOT NULL REFERENCES content_sequences(id),
  sequence_segment         text NOT NULL DEFAULT '',
  sequence_value           bigint NOT NULL,
  title                    text NOT NULL,
  brief                    text NOT NULL DEFAULT '',
  client_id                uuid REFERENCES clients(id),
  channel_id               uuid REFERENCES channels(id),
  project_id               uuid,               -- FK added in the projects milestone
  branch_id                uuid NOT NULL REFERENCES branches(id),
  department_id            uuid REFERENCES departments(id),
  format                   text NOT NULL,
  platforms                text[] NOT NULL DEFAULT '{}',
  language                 text NOT NULL DEFAULT 'Telugu',
  priority                 text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  stage                    text NOT NULL DEFAULT 'idea',
  stage_owner_id           uuid REFERENCES users(id),
  stage_entered_at         timestamptz NOT NULL DEFAULT now(),
  stage_due_at             timestamptz,
  due_at                   timestamptz,
  requires_client_approval boolean NOT NULL DEFAULT false,
  producer_id              uuid REFERENCES users(id),
  script_writer_id         uuid REFERENCES users(id),
  camera_operator_id       uuid REFERENCES users(id),
  editor_id                uuid REFERENCES users(id),
  publisher_id             uuid REFERENCES users(id),
  revision_count           int NOT NULL DEFAULT 0,
  version                  int NOT NULL DEFAULT 1,   -- optimistic concurrency for transitions/edits
  cancel_reason            text,
  is_demo                  boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid NOT NULL REFERENCES users(id),
  updated_by               uuid REFERENCES users(id),
  UNIQUE (organisation_id, content_code),
  UNIQUE (sequence_id, sequence_segment, sequence_value),
  CHECK ((client_id IS NULL) <> (channel_id IS NULL))
);
CREATE TRIGGER content_items_touch BEFORE UPDATE ON content_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX content_stage_idx ON content_items(organisation_id, stage, stage_due_at);
CREATE INDEX content_owner_idx ON content_items(stage_owner_id, stage);
CREATE INDEX content_client_idx ON content_items(client_id, created_at DESC);
CREATE INDEX content_channel_idx ON content_items(channel_id, created_at DESC);
CREATE INDEX content_branch_idx ON content_items(organisation_id, branch_id, created_at DESC);
CREATE INDEX content_editor_idx ON content_items(editor_id, stage);

-- Content can never be hard-deleted: IDs must never be reused.
CREATE OR REPLACE FUNCTION content_items_no_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'content_items cannot be deleted; cancel or archive instead'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER content_items_no_delete BEFORE DELETE ON content_items FOR EACH ROW EXECUTE FUNCTION content_items_no_delete();

-- Lifecycle history: one row per transition, assignment, escalation.
CREATE TABLE content_events (
  id          bigserial PRIMARY KEY,
  content_id  uuid NOT NULL REFERENCES content_items(id),
  kind        text NOT NULL CHECK (kind IN ('created','transition','assignment','escalation','comment')),
  from_stage  text,
  to_stage    text,
  note        text,
  assignee_id uuid REFERENCES users(id),
  actor_id    uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_events_item_idx ON content_events(content_id, id);
CREATE TRIGGER content_events_no_update BEFORE UPDATE OR DELETE ON content_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

CREATE TABLE content_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_items(id),
  author_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','client')),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  deleted_at timestamptz
);
CREATE INDEX content_comments_item_idx ON content_comments(content_id, created_at);

-- ── Notifications (in-app now; push/email delivery workers in a later milestone) ──
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  kind            text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL DEFAULT '',
  entity_type     text,
  entity_id       text,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

