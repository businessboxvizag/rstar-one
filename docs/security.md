# Security, privacy and location policy

## Threat model (summary)

| Threat | Control | Status |
|---|---|---|
| Employee views data outside their role (payroll, other branches, other clients) | Server-side permission + scope checks on every request; SQL scope predicates on lists; 404 for out-of-scope records; permission tests | ✅ |
| Client portal user sees internal or other-client data | Separate `kind=client` identity; client roles cannot hold staff permissions (enforced at load); responses trimmed to client-safe fields; internal comments hidden | ✅ |
| Privilege escalation by HR or a compromised account | Only `roles.manage` can grant MFA-required roles; nobody can change their own roles; Super Admin role cannot be reduced; all role changes audited | ✅ |
| Credential stuffing / brute force | scrypt hashes, lockout after 5 failures, per IP+email rate limits, generic error messages, no account enumeration on reset | ✅ |
| Stolen session | 15-minute access tokens; refresh rotation (a just-rotated token is honoured for 20 s for concurrent tabs, reuse after that revokes the session); per-device revocation; deactivation and password reset revoke all sessions immediately | ✅ |
| Privileged account takeover | TOTP MFA; with enforcement on, sensitive permissions are withheld until MFA is enrolled | ✅ |
| Tampering with history | Audit log and content history are append-only at the database level; content items cannot be deleted | ✅ |
| Leaking secrets | No secrets in client apps; `.env` never committed; passwords/tokens redacted from audit; bank/PAN/UAN and MFA secrets encrypted with AES-256-GCM | ✅ |
| Spoofed GPS | Server re-evaluates every check (geofence distance, reported accuracy, Android mock-location flag, impossible travel, client clock skew); server time only; anything unusual becomes a pending exception for a manager, never auto-verified; attendance events cannot be deleted. A rooted device can still fake coordinates convincingly, which is why exceptions and patterns are reviewed by people | ✅ M2 |
| Unauthorised file access | Short-lived signed URLs only, download logging, no public buckets | 🗓 M6 |
| Web vulnerabilities | Parameterised SQL only; Zod validation on every input; helmet headers; CORS allow-list; JSON body limit 1 MB | ✅ (CSP tuned in web app) |
| Data loss | PITR + independent backups + quarterly restore drill | 🗓 M6/M10 |

Before launch: dependency audit, an external security review / penetration test, and a review of Indian privacy obligations (Digital Personal Data Protection Act, 2023 and its rules) by a qualified professional.

## Data protection

* Collect only what each workflow needs. Sensitive HR fields are separated (`employee_sensitive`) and every read is audited.
* Employees can see and download their own data; export and deletion requests follow a documented process (HR + Super Admin), subject to statutory retention for payroll/finance records.
* Encryption in transit (TLS everywhere) and at rest (managed database and bucket encryption plus application-level encryption for sensitive fields).

## Employee location policy (draft for HR/legal review)

> RSTAR ONE uses your phone's location **only at the moment you tap Check in or Check out** (and break start/end if your branch uses break tracking). It does **not** track you in the background, during the day, or outside working hours.
>
> What is recorded: the time, your coordinates, the accuracy reported by your phone, whether you were inside your office's area, and basic device information. This is used to confirm office attendance, to support field and work-from-home attendance where your manager allows it, and to detect misuse such as simulated locations.
>
> Who can see it: you, your reporting manager, your department head/branch manager and HR. Raw coordinates are kept for 12 months, then only the daily attendance result is kept.
>
> If location is unavailable or inaccurate, you can still submit attendance with a reason; it is marked "pending" and reviewed — it is never silently marked as verified.
>
> You will be asked for location permission ("while using the app" only) and to accept this notice the first time you check in. Contact HR with questions or to request your data.
