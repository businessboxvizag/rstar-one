"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { STAGE_LABELS, STAGE_PHASE, type ContentStage, type StagePhase } from "@rstar/shared";
import { api } from "@/lib/api";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-ink-muted">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="card flex items-center justify-between gap-3 border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span>{error}</span>
      {onRetry && <button className="btn-secondary" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="card animate-pulse px-4 py-8 text-center text-sm text-ink-muted">{label}</div>;
}

const PHASE_STYLE: Record<StagePhase, string> = {
  planning: "bg-slate-100 text-slate-700",
  script: "bg-violet-50 text-violet-700",
  shoot: "bg-amber-50 text-amber-800",
  footage: "bg-orange-50 text-orange-800",
  edit: "bg-sky-50 text-sky-800",
  review: "bg-rose-50 text-rose-700",
  publish: "bg-emerald-50 text-emerald-800",
  analytics: "bg-teal-50 text-teal-800",
  closed: "bg-gray-100 text-gray-600",
};

export function StageChip({ stage }: { stage: ContentStage }) {
  return <span className={`chip ${PHASE_STYLE[STAGE_PHASE[stage]]}`}>{STAGE_LABELS[stage]}</span>;
}

/** Small data hook: loads, exposes error/loading, and a reload function. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api<T>(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load data");
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load };
}

export function formatDate(v: string | null | undefined, withTime = false) {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleString("en-IN", withTime ? { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" } : { dateStyle: "medium", timeZone: "Asia/Kolkata" });
}
