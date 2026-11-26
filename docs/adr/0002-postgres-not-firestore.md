# ADR-0002: PostgreSQL instead of Firestore

**Status:** accepted (Milestone 1). The project brief allowed either; the attached blueprint leaned to Firestore, the latest brief recommends PostgreSQL. We follow the latest brief.

**Context.** The core of the system is relational and transactional: payroll runs with line items and approvals, invoices and payments that must reconcile, leave balances that change attendance and payroll, Content IDs that must be unique and gap-free under concurrency, and reports that join across employees, branches, clients and content.

**Decision.** PostgreSQL 16 for all business data, with forward-only SQL migrations, foreign keys, check constraints, unique constraints and partial indexes. Media binaries are never stored in the database. Use a managed Postgres with point-in-time recovery in production.

**Consequences.**
* Content IDs use a counter row updated with `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the same transaction as the item insert; uniqueness is also enforced by `UNIQUE (organisation_id, content_code)`.
* Append-only tables (audit, content history) are protected by triggers.
* Reporting is plain SQL; heavy reports can move to materialised views later.
* Real-time UI updates use polling or server-sent events instead of Firestore listeners.
