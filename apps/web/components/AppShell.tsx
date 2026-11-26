"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { PermissionKey } from "@rstar/shared";
import { useAuth } from "@/lib/auth";

interface NavItem {
  href: string;
  label: string;
  perm?: PermissionKey;
  icon: string;
}

// Only modules that exist are listed; more appear as each milestone lands.
const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "M3 12l9-9 9 9M5 10v10h14V10" },
  { href: "/production", label: "Production", perm: "content.read", icon: "M4 6h16M4 12h16M4 18h10" },
  { href: "/people", label: "People", perm: "employees.read", icon: "M16 14a4 4 0 10-8 0M12 10a3 3 0 100-6 3 3 0 000 6M4 20h16" },
  { href: "/audit", label: "Audit log", perm: "audit.read", icon: "M9 12h6M9 16h6M7 4h10l2 2v14H5V4z" },
  { href: "/settings", label: "Settings", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, loading, can, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("rstar.sidebar") === "collapsed");
    } catch {
      /* storage unavailable */
    }
  }, []);
  useEffect(() => setMobileOpen(false), [pathname]);

  if (loading || !me) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-muted">Loading your workspace…</div>;
  }

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("rstar.sidebar", next ? "collapsed" : "open");
    } catch {
      /* ignore */
    }
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = search.trim();
    if (q) router.push(`/production?q=${encodeURIComponent(q)}`);
  };

  const items = NAV.filter((n) => !n.perm || can(n.perm));
  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2.5 border-b border-line px-4">
        <Image src="/rstar-tv-logo.png" alt="RSTAR TV" width={34} height={34} />
        {!collapsed && (
          <span className="text-base font-semibold tracking-tight">
            {me.organisation.productName.replace(/ONE$/, "")}
            <span className="text-rstar">{me.organisation.productName.endsWith("ONE") ? "ONE" : ""}</span>
          </span>
        )}
      </div>
      <ul className="flex-1 space-y-0.5 p-2">
        {items.map((n) => {
          const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={active ? "page" : undefined}
                title={collapsed ? n.label : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-rstar-light text-rstar-dark" : "text-ink-muted hover:bg-canvas hover:text-ink"}`}
              >
                <Icon d={n.icon} />
                {!collapsed && n.label}
              </Link>
            </li>
          );
        })}
      </ul>
      {!collapsed && <p className="border-t border-line px-4 py-3 text-[11px] leading-snug text-ink-faint">{me.organisation.partnerLabel}</p>}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className={`sticky top-0 hidden h-screen shrink-0 border-r border-line bg-white md:block ${collapsed ? "w-[68px]" : "w-60"}`}>{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal>
          <button className="absolute inset-0 bg-ink/30" aria-label="Close menu" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-white/90 px-4 backdrop-blur">
          <button className="btn-ghost px-2 md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Icon d="M4 6h16M4 12h16M4 18h16" />
          </button>
          <button className="btn-ghost hidden px-2 md:inline-flex" onClick={toggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            <Icon d={collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} />
          </button>
          <form onSubmit={onSearch} className="max-w-md flex-1" role="search">
            <label htmlFor="global-search" className="sr-only">Search by Content ID or title</label>
            <input id="global-search" className="input" placeholder="Search Content ID (e.g. CC001) or title" value={search} onChange={(e) => setSearch(e.target.value)} />
          </form>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium">{me.user.displayName}</div>
              <div className="text-xs text-ink-muted">{me.roles.filter((r) => r !== "employee").join(", ").replace(/_/g, " ") || "employee"}</div>
            </div>
            <button className="btn-secondary" onClick={() => void signOut()}>Sign out</button>
          </div>
        </header>
        {(me.security.mfaEnrollmentPending || me.security.mustChangePassword) && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
            {me.security.mustChangePassword && <span>Please change your temporary password. </span>}
            {me.security.mfaEnrollmentPending && <span>Your role requires two-factor authentication; admin features stay locked until you set it up. </span>}
            <Link href="/settings" className="font-medium underline">Open security settings</Link>
          </div>
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
