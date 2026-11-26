-- RSTAR ONE · Milestone 2 · Attendance (GPS check-in/out, geofences, ledger, corrections) and Leave.
-- Office coordinates are NOT seeded: an admin must set each branch geofence. Until then office
-- check-ins are recorded as pending exceptions, never as verified.

ALTER TABLE employees ADD COLUMN location_consent_at timestamptz;
ALTER TABLE employees ADD COLUMN location_consent_version text;

CREATE TABLE geofences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  branch_id       uuid NOT NULL UNIQUE REFERENCES branches(id),
  latitude        numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude       numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m        int NOT NULL DEFAULT 150 CHECK (radius_m BETWEEN 25 AND 5000),
  max_accuracy_m  int NOT NULL DEFAULT 100 CHECK (max_accuracy_m BETWEEN 5 AND 2000),
  active          boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id)
);

-- One default policy per organisation (branch_id NULL) plus optional per-branch overrides.
CREATE TABLE attendance_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       uuid NOT NULL REFERENCES organisations(id),
  branch_id             uuid REFERENCES branches(id),
  work_start            time NOT NULL DEFAULT '09:30',
  work_end              time NOT NULL DEFAULT '18:30',
  grace_minutes         int NOT NULL DEFAULT 15 CHECK (grace_minutes BETWEEN 0 AND 240),
  early_leave_minutes   int NOT NULL DEFAULT 15 CHECK (early_leave_minutes BETWEEN 0 AND 240),
  half_day_minutes      int NOT NULL DEFAULT 240 CHECK (half_day_minutes > 0),
  full_day_minutes      int NOT NULL DEFAULT 480 CHECK (full_day_minutes > 0),
  weekly_offs           int[] NOT NULL DEFAULT '{0}',   -- 0 = Sunday … 6 = Saturday
  allow_wfh             boolean NOT NULL DEFAULT false,
  allow_field           boolean NOT NULL DEFAULT true,
  track_breaks          boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id),
  CHECK (half_day_minutes <= full_day_minutes)
);
CREATE UNIQUE INDEX attendance_policies_org_default ON attendance_policies(organisation_id) WHERE branch_id IS NULL;
CREATE UNIQUE INDEX attendance_policies_branch ON attendance_policies(branch_id) WHERE branch_id IS NOT NULL;

CREATE TABLE attendance_events (
  id               bigserial PRIMARY KEY,
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  work_date        date NOT NULL,                  -- in the branch timezone
  kind             text NOT NULL CHECK (kind IN ('check_in','check_out','break_start','break_end')),
  mode             text NOT NULL CHECK (mode IN ('office','wfh','field')),
  server_time      timestamptz NOT NULL DEFAULT now(),
  client_time      timestamptz,
  latitude         numeric(9,6),
  longitude        numeric(9,6),
  accuracy_m       numeric(8,1),
  distance_m       numeric(10,1),
  geofence_id      uuid REFERENCES geofences(id),
  result           text NOT NULL CHECK (result IN ('verified','remote','pending_exception','approved_exception','rejected')),
  flags            text[] NOT NULL DEFAULT '{}',
  note             text,
  device_id        text,
  idempotency_key  text,
  reviewed_by      uuid REFERENCES users(id),
  reviewed_at      timestamptz,
  review_note      text,
  UNIQUE (employee_id, idempotency_key)
);
CREATE INDEX attendance_events_emp_idx ON attendance_events(employee_id, work_date, server_time);
CREATE INDEX attendance_events_review_idx ON attendance_events(organisation_id, result) WHERE result = 'pending_exception';
CREATE TRIGGER attendance_events_no_delete BEFORE DELETE ON attendance_events FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Derived daily ledger, recomputed from events, approved corrections, approved leave and holidays.
CREATE TABLE attendance_days (
  employee_id     uuid NOT NULL REFERENCES employees(id),
  work_date       date NOT NULL,
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  status          text NOT NULL CHECK (status IN ('present','late','half_day','absent','on_leave','half_day_leave','holiday','weekly_off','wfh','field','pending_review','in_progress')),
  first_in        timestamptz,
  last_out        timestamptz,
  worked_minutes  int NOT NULL DEFAULT 0,
  late_minutes    int NOT NULL DEFAULT 0,
  early_minutes   int NOT NULL DEFAULT 0,
  source          text NOT NULL DEFAULT 'events',
  needs_review    boolean NOT NULL DEFAULT false,
  leave_request_id uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, work_date)
);
CREATE INDEX attendance_days_branch_idx ON attendance_days(organisation_id, branch_id, work_date);

CREATE TABLE attendance_corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  employee_id     uuid NOT NULL REFERENCES employees(id),
  work_date       date NOT NULL,
  check_in_at     timestamptz,
  check_out_at    timestamptz,
  mode            text NOT NULL DEFAULT 'office' CHECK (mode IN ('office','wfh','field')),
  reason          text NOT NULL,
  kind            text NOT NULL DEFAULT 'request' CHECK (kind IN ('request','manual')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  requested_by    uuid NOT NULL REFERENCES users(id),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (check_in_at IS NOT NULL OR check_out_at IS NOT NULL),
  CHECK (check_out_at IS NULL OR check_in_at IS NULL OR check_out_at > check_in_at),
  CHECK (decided_by IS NULL OR decided_by <> requested_by OR kind = 'manual')
);
CREATE INDEX attendance_corrections_emp_idx ON attendance_corrections(employee_id, work_date);
CREATE INDEX attendance_corrections_pending_idx ON attendance_corrections(organisation_id) WHERE status = 'pending';

CREATE TABLE holidays (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id),
  branch_id       uuid REFERENCES branches(id),   -- NULL = all branches
  holiday_date    date NOT NULL,
  name            text NOT NULL,
  optional        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX holidays_uq ON holidays(organisation_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);

-- ── Leave ──────────────────────────────────────────────────────────────────
CREATE TABLE leave_types (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id          uuid NOT NULL REFERENCES organisations(id),
  code                     text NOT NULL CHECK (code ~ '^[A-Z]{2,6}$'),
  name                     text NOT NULL,
  paid                     boolean NOT NULL DEFAULT true,
  annual_quota             numeric(5,1) NOT NULL DEFAULT 0 CHECK (annual_quota >= 0),
  accrual                  text NOT NULL DEFAULT 'yearly' CHECK (accrual IN ('yearly','monthly','none')),
  carry_forward_max        numeric(5,1) NOT NULL DEFAULT 0 CHECK (carry_forward_max >= 0),
  allow_half_day           boolean NOT NULL DEFAULT true,
  requires_document_after_days numeric(4,1),
  unlimited                boolean NOT NULL DEFAULT false,   -- e.g. unpaid leave: no balance check
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code)
);

CREATE TABLE leave_balances (
  employee_id    uuid NOT NULL REFERENCES employees(id),
  leave_type_id  uuid NOT NULL REFERENCES leave_types(id),
  year           int NOT NULL,
  opening        numeric(5,1) NOT NULL DEFAULT 0,
  accrued        numeric(5,1) NOT NULL DEFAULT 0,
  adjusted       numeric(5,1) NOT NULL DEFAULT 0,
  used           numeric(5,1) NOT NULL DEFAULT 0 CHECK (used >= 0),
  pending        numeric(5,1) NOT NULL DEFAULT 0 CHECK (pending >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, leave_type_id, year)
);

CREATE TABLE leave_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  leave_type_id    uuid NOT NULL REFERENCES leave_types(id),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  start_half       boolean NOT NULL DEFAULT false,   -- starts after lunch
  end_half         boolean NOT NULL DEFAULT false,   -- ends before lunch
  days             numeric(5,1) NOT NULL CHECK (days > 0),
  reason           text NOT NULL,
  document_ref     text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled','withdrawn')),
  approver_user_id uuid REFERENCES users(id),
  decided_by       uuid REFERENCES users(id),
  decided_at       timestamptz,
  decision_note    text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  CHECK (end_date >= start_date),
  CHECK (decided_by IS NULL OR decided_by <> created_by OR status IN ('cancelled','withdrawn'))
);
CREATE INDEX leave_requests_emp_idx ON leave_requests(employee_id, start_date);
CREATE INDEX leave_requests_pending_idx ON leave_requests(organisation_id, status) WHERE status = 'pending';
CREATE INDEX leave_requests_range_idx ON leave_requests(organisation_id, start_date, end_date) WHERE status IN ('pending','approved');
