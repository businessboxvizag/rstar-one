"use client";

export const DAY_LABEL: Record<string, string> = {
  present: "Present", late: "Late", half_day: "Half day", absent: "Absent", on_leave: "On leave", half_day_leave: "Half-day leave",
  holiday: "Holiday", weekly_off: "Weekly off", wfh: "Work from home", field: "Field work", pending_review: "Needs review", in_progress: "In progress",
};
const DAY_STYLE: Record<string, string> = {
  present: "bg-emerald-50 text-emerald-800", late: "bg-amber-50 text-amber-800", half_day: "bg-amber-50 text-amber-800",
  absent: "bg-red-50 text-red-700", on_leave: "bg-sky-50 text-sky-800", half_day_leave: "bg-sky-50 text-sky-800",
  holiday: "bg-violet-50 text-violet-700", weekly_off: "bg-gray-100 text-gray-600", wfh: "bg-teal-50 text-teal-800",
  field: "bg-teal-50 text-teal-800", pending_review: "bg-orange-50 text-orange-800", in_progress: "bg-slate-100 text-slate-700",
};
export function DayChip({ status }: { status: string }) {
  return <span className={`chip ${DAY_STYLE[status] ?? "bg-canvas text-ink-muted"}`}>{DAY_LABEL[status] ?? status}</span>;
}

const RESULT: Record<string, [string, string]> = {
  verified: ["Verified", "bg-emerald-50 text-emerald-800"],
  remote: ["Remote", "bg-teal-50 text-teal-800"],
  pending_exception: ["Needs review", "bg-orange-50 text-orange-800"],
  approved_exception: ["Approved", "bg-emerald-50 text-emerald-800"],
  rejected: ["Rejected", "bg-red-50 text-red-700"],
};
export function ResultChip({ result }: { result: string }) {
  const [label, cls] = RESULT[result] ?? [result, "bg-canvas text-ink-muted"];
  return <span className={`chip ${cls}`}>{label}</span>;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-800", approved: "bg-emerald-50 text-emerald-800", rejected: "bg-red-50 text-red-700",
  cancelled: "bg-gray-100 text-gray-600", withdrawn: "bg-gray-100 text-gray-600",
};
export function StatusChip({ status }: { status: string }) {
  return <span className={`chip capitalize ${STATUS_STYLE[status] ?? "bg-canvas text-ink-muted"}`}>{status}</span>;
}

export const time = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";
export const hours = (m: number) => (m ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : "—");

/** One GPS fix from the browser. Never cached: maximumAge 0. */
export function getFix(): Promise<{ latitude: number; longitude: number; accuracyM: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("This browser cannot share location"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? "Location permission was denied. Allow location for this site and try again." : "Could not get your location. Try again near a window or outdoors.")),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}
