/**
 * Content ID formatting. Allocation (the number) always happens on the server
 * inside a database transaction; this module only formats and parses.
 *
 *   formatContentId({ prefix: "CC", value: 1 })                      -> "CC001"
 *   formatContentId({ prefix: "RN", segment: "2026", value: 12 })    -> "RN-2026-012"
 *   formatContentId({ prefix: "CC", value: 1234 })                   -> "CC1234"
 */
export const PREFIX_RE = /^[A-Z]{2,8}$/;
export const SEGMENT_RE = /^[A-Z0-9]{1,12}$/;

export interface ContentIdParts {
  prefix: string;
  segment?: string | null;
  value: number;
  /** Minimum digits; numbers grow past it rather than wrap. */
  padding?: number;
}

export function formatContentId({ prefix, segment, value, padding = 3 }: ContentIdParts): string {
  if (!PREFIX_RE.test(prefix)) throw new Error(`Invalid content ID prefix: ${prefix}`);
  if (segment != null && !SEGMENT_RE.test(segment)) throw new Error(`Invalid content ID segment: ${segment}`);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid sequence value: ${value}`);
  const n = String(value).padStart(padding, "0");
  return segment ? `${prefix}-${segment}-${n}` : `${prefix}${n}`;
}

export function parseContentId(id: string): ContentIdParts | null {
  const seg = /^([A-Z]{2,8})-([A-Z0-9]{1,12})-(\d+)$/.exec(id);
  if (seg) return { prefix: seg[1]!, segment: seg[2]!, value: Number(seg[3]) };
  const plain = /^([A-Z]{2,8})(\d+)$/.exec(id);
  if (plain) return { prefix: plain[1]!, segment: null, value: Number(plain[2]) };
  return null;
}

/** Normalises user search input ("cc 1", "cc001", "CC-2026-1") to a canonical-ish query. */
export function normaliseContentIdQuery(q: string): string {
  return q.trim().toUpperCase().replace(/\s+/g, "");
}
