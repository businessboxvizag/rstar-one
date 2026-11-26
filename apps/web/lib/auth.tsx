"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { PermissionKey, Scope } from "@rstar/shared";
import { api, logout as apiLogout, refreshSession } from "./api";

export interface Me {
  user: { id: string; email: string; displayName: string; kind: "staff" | "client"; employeeId: string | null; branchId: string | null; departmentId: string | null };
  roles: string[];
  permissions: Partial<Record<PermissionKey, Scope>>;
  security: { mfaEnabled: boolean; mfaRequired: boolean; mfaEnrollmentPending: boolean; mustChangePassword: boolean };
  organisation: { productName: string; partnerLabel: string };
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (perm: PermissionKey) => boolean;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>("/me"));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const ok = await refreshSession();
      if (!ok) {
        setLoading(false);
        router.replace("/login");
        return;
      }
      await reload();
    })();
  }, [reload, router]);

  const signOut = useCallback(async () => {
    await apiLogout();
    setMe(null);
    router.replace("/login");
  }, [router]);

  const can = useCallback((perm: PermissionKey) => Boolean(me?.permissions[perm]), [me]);

  return <Ctx.Provider value={{ me, loading, can, reload, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
