import { describe, expect, it } from "vitest";
import {
  CONTENT_STAGES,
  DEFAULT_ROLES,
  TRANSITIONS,
  effectiveGrants,
  findTransition,
  formatContentId,
  nextStages,
  parseContentId,
  distanceMetres,
  CreateContentInput,
  isPermissionKey,
} from "./index.js";

describe("content IDs", () => {
  it("formats per the spec examples", () => {
    expect(formatContentId({ prefix: "CC", value: 1 })).toBe("CC001");
    expect(formatContentId({ prefix: "RN", value: 2 })).toBe("RN002");
    expect(formatContentId({ prefix: "PH", value: 42 })).toBe("PH042");
    expect(formatContentId({ prefix: "CC", value: 1234 })).toBe("CC1234");
    expect(formatContentId({ prefix: "RN", segment: "2026", value: 7 })).toBe("RN-2026-007");
  });
  it("rejects invalid prefixes and values", () => {
    expect(() => formatContentId({ prefix: "cc", value: 1 })).toThrow();
    expect(() => formatContentId({ prefix: "CC", value: 0 })).toThrow();
  });
  it("round-trips through parse", () => {
    expect(parseContentId("AV017")).toEqual({ prefix: "AV", segment: null, value: 17 });
    expect(parseContentId("RN-DIWALI-003")).toEqual({ prefix: "RN", segment: "DIWALI", value: 3 });
    expect(parseContentId("nope")).toBeNull();
  });
});

describe("workflow", () => {
  it("every transition references real stages and permissions", () => {
    for (const t of TRANSITIONS) {
      expect(CONTENT_STAGES).toContain(t.from);
      expect(CONTENT_STAGES).toContain(t.to);
      expect(isPermissionKey(t.permission)).toBe(true);
    }
  });
  it("every non-terminal stage has a way forward and archived is reachable from idea", () => {
    const seen = new Set<string>(["idea"]);
    const queue = ["idea"];
    while (queue.length) {
      const s = queue.shift()!;
      for (const t of nextStages(s as never)) if (!seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
    }
    for (const s of CONTENT_STAGES) expect(seen.has(s), s).toBe(true);
  });
  it("rejections require a note", () => {
    expect(findTransition("script_in_review", "script_assigned")[0]?.requiresNote).toBe(true);
    expect(findTransition("internal_review", "revisions_requested")[0]?.requiresNote).toBe(true);
  });
  it("cannot cancel after publishing or skip stages", () => {
    expect(findTransition("published", "cancelled")).toHaveLength(0);
    expect(findTransition("idea", "published")).toHaveLength(0);
  });
});

describe("permissions", () => {
  const role = (k: string) => DEFAULT_ROLES.find((r) => r.key === k)!;
  it("employees get self-service only", () => {
    const g = effectiveGrants([role("employee")]);
    expect(g["attendance.self"]).toBe("own");
    expect(g["payroll.read"]).toBeUndefined();
    expect(g["employees.read"]).toBe("own");
  });
  it("widest scope wins across roles", () => {
    const g = effectiveGrants([role("department_head"), role("branch_manager")]);
    expect(g["employees.read"]).toBe("branch");
  });
  it("payroll processing and approval are separated", () => {
    expect(role("hr_admin").grants["payroll.approve"]).toBeUndefined();
    expect(role("management").grants["payroll.process"]).toBeUndefined();
  });
  it("client users get no staff base grants", () => {
    const g = effectiveGrants([role("client_user")]);
    expect(g["attendance.self"]).toBeUndefined();
    expect(g["review.client"]).toBe("own");
  });
  it("super admin cannot act as a client reviewer", () => {
    expect(role("super_admin").grants["review.client"]).toBeUndefined();
  });
});

describe("schemas", () => {
  it("requires exactly one of client or channel", () => {
    const base = { title: "x", branchId: "00000000-0000-4000-8000-000000000000" };
    expect(CreateContentInput.safeParse(base).success).toBe(false);
    expect(CreateContentInput.safeParse({ ...base, clientId: base.branchId }).success).toBe(true);
    expect(CreateContentInput.safeParse({ ...base, clientId: base.branchId, channelId: base.branchId }).success).toBe(false);
  });
});

describe("geo", () => {
  it("computes plausible distances", () => {
    // Vizag RK Beach to Vizag railway station ~ 3.5 km
    const d = distanceMetres({ lat: 17.7142, lng: 83.3237 }, { lat: 17.7215, lng: 83.2905 });
    expect(d).toBeGreaterThan(3000);
    expect(d).toBeLessThan(4000);
  });
});
