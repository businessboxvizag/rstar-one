-- RSTAR ONE · Milestone 1 · Foundation schema
-- Organisation, structure, identity, RBAC, employees, audit log.
-- Conventions: uuid PKs, organisation_id on every business row, timestamptz,
-- created_by/updated_by, soft-delete via archived_at where records must be kept.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

-- ── Organisation ───────────────────────────────────────────────────────────
CREATE TABLE organisations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name    text NOT NULL,
  product_name  text NOT NULL DEFAULT 'RSTAR ONE',
  partner_label text NOT NULL DEFAULT 'Technology & Operations by BusinessBOX',
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  currency      char(3) NOT NULL DEFAULT 'INR',
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organisations_touch BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z]{2,6}$'),
  name            text NOT NULL,
  city            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  UNIQUE (organisation_id, code)
);
CREATE TRIGGER branches_touch BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE departments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z_]{2,16}$'),
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  UNIQUE (organisation_id, code)
);
CREATE TRIGGER departments_touch BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  department_id   uuid NOT NULL REFERENCES departments(id),
  branch_id       uuid REFERENCES branches(id),
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, department_id, name)
);

CREATE TABLE designations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  department_id   uuid REFERENCES departments(id),
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, name)
);

-- ── Identity ───────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id),
  kind                text NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff','client')),
  email               citext NOT NULL,
  display_name        text NOT NULL,
  password_hash       text,                      -- scrypt; null until invitation accepted
  must_change_password boolean NOT NULL DEFAULT false,
  mfa_secret_enc      text,                      -- AES-256-GCM encrypted TOTP secret
  mfa_enabled_at      timestamptz,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','locked','deactivated')),
  failed_logins       int NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  client_id           uuid,                      -- FK added once clients table exists (0002)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  UNIQUE (organisation_id, email),
  CHECK (kind = 'staff' OR client_id IS NOT NULL)
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,  -- sha256 of opaque token; rotated on every refresh
  mfa_verified       boolean NOT NULL DEFAULT false,
  user_agent         text,
  ip                 inet,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE one_time_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('invite','password_reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── RBAC ───────────────────────────────────────────────────────────────────
CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  key             text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{2,40}$'),
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  audience        text NOT NULL DEFAULT 'staff' CHECK (audience IN ('staff','client')),
  mfa_required    boolean NOT NULL DEFAULT false,
  is_system       boolean NOT NULL DEFAULT false,  -- seeded roles: grants editable, key not deletable
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, key)
);
CREATE TRIGGER roles_touch BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('own','team','department','branch','org')),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- ── Employees (HR profile, 1:1 with a staff user) ─────────────────────────
CREATE TABLE employees (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id),
  user_id              uuid NOT NULL UNIQUE REFERENCES users(id),
  employee_code        text NOT NULL,
  full_name            text NOT NULL,
  email                citext NOT NULL,
  phone                text,
  photo_asset_id       uuid,
  address              jsonb,
  emergency_contact    jsonb,
  branch_id            uuid NOT NULL REFERENCES branches(id),
  department_id        uuid NOT NULL REFERENCES departments(id),
  team_id              uuid REFERENCES teams(id),
  designation_id       uuid REFERENCES designations(id),
  reporting_manager_id uuid REFERENCES employees(id),
  employment_type      text NOT NULL DEFAULT 'full_time'
                         CHECK (employment_type IN ('full_time','part_time','contract','intern','consultant')),
  status               text NOT NULL DEFAULT 'onboarding'
                         CHECK (status IN ('onboarding','probation','active','notice','exited','archived')),
  joining_date         date NOT NULL,
  probation_end_date   date,
  exit_date            date,
  skills               text[] NOT NULL DEFAULT '{}',
  -- Restricted fields (bank, PAN, salary structure ref) are stored encrypted in
  -- employee_sensitive and only returned with employees.sensitive.read.
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  updated_by           uuid REFERENCES users(id),
  UNIQUE (organisation_id, employee_code),
  CHECK (reporting_manager_id IS DISTINCT FROM id)
);
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX employees_branch_idx ON employees(organisation_id, branch_id, status);
CREATE INDEX employees_dept_idx ON employees(organisation_id, department_id, status);
CREATE INDEX employees_manager_idx ON employees(reporting_manager_id);

CREATE TABLE employee_sensitive (
  employee_id   uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  data_enc      text NOT NULL,      -- AES-256-GCM JSON blob: bank, IFSC, PAN, UAN, etc.
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id)
);

-- Full history of role changes, transfers, status changes, probation, exit.
CREATE TABLE employee_history (
  id           bigserial PRIMARY KEY,
  employee_id  uuid NOT NULL REFERENCES employees(id),
  kind         text NOT NULL,       -- created | transfer | status | designation | manager | roles
  before       jsonb,
  after        jsonb,
  effective_on date NOT NULL DEFAULT current_date,
  actor_id     uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_history_emp_idx ON employee_history(employee_id, created_at DESC);

CREATE SEQUENCE employee_code_seq START 1;

-- ── Audit log (append-only) ────────────────────────────────────────────────
CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  actor_user_id   uuid REFERENCES users(id),
  action          text NOT NULL,          -- e.g. employee.create, content.transition, auth.login_failed
  entity_type     text NOT NULL,
  entity_id       text,
  before          jsonb,
  after           jsonb,
  ip              inet,
  user_agent      text,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_events(organisation_id, entity_type, entity_id, created_at DESC);
CREATE INDEX audit_actor_idx ON audit_events(organisation_id, actor_user_id, created_at DESC);
CREATE INDEX audit_time_idx ON audit_events(organisation_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
