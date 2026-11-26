# ADR-0004: Cloudflare R2 + office NAS + independent backup for media

**Status:** proposed (implementation in Milestone 6; needs accounts and credentials)

**Context.** 3–5 TB of new footage per month, from Hyderabad and Vizag shoots, currently shared as Google Drive links over WhatsApp. Editors download often, so egress cost matters more than raw storage price.

**Decision.**
* **Ingest + hot tier:** Cloudflare R2 (S3 API, no egress fees). Field teams upload directly with S3 multipart uploads using short-lived presigned part URLs; uploads resume part-by-part after interruption.
* **Integrity:** client computes SHA-256 per part and for the whole file; the server verifies part ETags/checksums on completion and records the hash for duplicate detection.
* **Active editing:** office NAS mirrors the "active" content folders (sync agent pulls assigned content), so editors work at LAN speed.
* **Archive:** after the hot window (default 90 days after final approval), raw footage moves to an archive tier (R2 Infrequent Access or Backblaze B2). Finals, proxies and thumbnails stay hot.
* **Backup:** independent copy in a separate account/provider with object lock where available; quarterly restore drill.
* **Folder template per Content ID:** `01_RAW_FOOTAGE`, `02_EDITING_PROJECT`, `03_FIRST_CUT`, `04_REVISIONS`, `05_FINAL_EXPORT`.
* **Drive bridge:** existing Drive links are registered against Content IDs (metadata only); migration is gradual.

**Consequences.** No automatic deletion without an approved retention policy. Cost forecast in [storage-and-cost.md](../storage-and-cost.md).
