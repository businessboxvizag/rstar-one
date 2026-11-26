-- RSTAR ONE · Tasks: assign work directly to an employee, with due date, priority, status,
-- comments, an append-only history and notifications.

CREATE SEQUENCE task_no_seq;

CREATE TABLE tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id),
  task_no              bigint NOT NULL DEFAULT nextval('task_no_seq') UNIQUE,
  title                text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description          text NOT NULL DEFAULT '',
  assignee_employee_id uuid NOT NULL REFERENCES employees(id),
  created_by           uuid NOT NULL REFERENCES users(id),
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  due_date             date,
  content_item_id      uuid REFERENCES content_items(id),
  started_at           timestamptz,
  completed_at         timestamptz,
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX tasks_assignee_idx ON tasks(assignee_employee_id, status, due_date);
CREATE INDEX tasks_creator_idx ON tasks(created_by, created_at DESC);
CREATE INDEX tasks_org_idx ON tasks(organisation_id, status, due_date);

CREATE TABLE task_comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid NOT NULL REFERENCES tasks(id),
  author_user_id uuid NOT NULL REFERENCES users(id),
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_comments_task_idx ON task_comments(task_id, created_at);

CREATE TABLE task_events (
  id         bigserial PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES tasks(id),
  actor_id   uuid NOT NULL REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('created','assigned','status','edited')),
  from_value text,
  to_value   text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events(task_id, id);

CREATE OR REPLACE FUNCTION task_history_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'task history is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON task_events FOR EACH ROW EXECUTE FUNCTION task_history_immutable();
CREATE TRIGGER task_comments_immutable BEFORE UPDATE OR DELETE ON task_comments FOR EACH ROW EXECUTE FUNCTION task_history_immutable();

-- Reporting managers can assign tasks to their direct reports (new base grant; seeding only
-- writes grants for newly created roles, so add it to existing organisations here).
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT id, 'tasks.manage', 'team' FROM roles WHERE key = 'employee_base'
ON CONFLICT (role_id, permission_key) DO NOTHING;
