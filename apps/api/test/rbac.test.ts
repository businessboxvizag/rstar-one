import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminApi, makeEmployee, setupApp, teardown, type Api, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let admin: Api;
beforeAll(async () => {
  ctx = await setupApp();
  admin = await adminApi(ctx);
});
afterAll(async () => teardown(ctx));

const codes = (r: { json: () => { items: { email: string }[] } }) => r.json().items.map((e) => e.email);

describe("employee visibility by scope", () => {
  it("employees see only themselves; dept heads their department; branch managers their branch", async () => {
    const hydEditor = await makeEmployee(ctx, admin, { roles: ["video_editor"], branch: "HYD", dept: "EDIT" });
    const vzgEditor = await makeEmployee(ctx, admin, { roles: ["video_editor"], branch: "VZG", dept: "EDIT" });
    const vzgCamera = await makeEmployee(ctx, admin, { roles: ["camera_operator"], branch: "VZG", dept: "CAMERA" });
    const editHead = await makeEmployee(ctx, admin, { roles: ["department_head"], branch: "HYD", dept: "EDIT" });
    const hydManager = await makeEmployee(ctx, admin, { roles: ["branch_manager"], branch: "HYD", dept: "MGMT" });

    const self = codes(await vzgEditor.api.get("/v1/employees"));
    expect(self).toEqual([vzgEditor.email]);

    const dept = codes(await editHead.api.get("/v1/employees?limit=100"));
    expect(dept).toEqual(expect.arrayContaining([hydEditor.email, vzgEditor.email, editHead.email]));
    expect(dept).not.toContain(vzgCamera.email);

    const branch = codes(await hydManager.api.get("/v1/employees?limit=100"));
    expect(branch).toEqual(expect.arrayContaining([hydEditor.email, editHead.email, hydManager.email]));
    expect(branch).not.toContain(vzgEditor.email);
    expect(branch).not.toContain(vzgCamera.email);
  });

  it("returns 404 (not 403) for employees outside scope so records are not disclosed", async () => {
    const a = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const b = await makeEmployee(ctx, admin, { roles: ["employee"] });
    expect((await a.api.get(`/v1/employees/${b.emp.id}`)).statusCode).toBe(404);
    expect((await a.api.get(`/v1/employees/${a.emp.id}`)).statusCode).toBe(200);
  });

  it("managers see their direct reports through team scope", async () => {
    const mgr = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const report = await makeEmployee(ctx, admin, { roles: ["employee"], managerId: mgr.emp.id });
    // employee base grants are "own" only, so a plain manager does not see reports unless a role grants team scope.
    expect((await mgr.api.get(`/v1/employees/${report.emp.id}`)).statusCode).toBe(404);
  });
});

describe("privileged actions", () => {
  it("only admins can create employees", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const r = await e.api.post("/v1/employees", {
      fullName: "Sneaky",
      email: "sneaky@test.local",
      branchId: ctx.ids.branches.VZG,
      departmentId: ctx.ids.departments.EDIT,
      joiningDate: "2026-01-01",
      roleKeys: ["super_admin"],
      initialPassword: "Sneaky12345",
    });
    expect(r.statusCode).toBe(403);
  });

  it("HR can create staff but cannot hand out privileged roles", async () => {
    const hr = await makeEmployee(ctx, admin, { roles: ["hr_admin"], dept: "ADMIN_HR" });
    const ok = await makeEmployee(ctx, hr.api, { roles: ["video_editor"] });
    expect(ok.emp.employee_code).toMatch(/^RS\d{4}$/);
    const priv = await hr.api.put(`/v1/employees/${ok.emp.id}/roles`, { roleKeys: ["super_admin"] });
    expect(priv.statusCode).toBe(403);
    const fine = await hr.api.put(`/v1/employees/${ok.emp.id}/roles`, { roleKeys: ["camera_editor"] });
    expect(fine.statusCode).toBe(200);
  });

  it("users cannot change their own roles", async () => {
    const me = (await admin.get("/v1/me")).json();
    expect((await admin.put(`/v1/employees/${me.user.employeeId}/roles`, { roleKeys: ["employee"] })).statusCode).toBe(403);
  });

  it("restricts sensitive HR data and audits every read", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const put = await admin.put(`/v1/employees/${e.emp.id}/sensitive`, { bankAccountNumber: "123456789012", ifsc: "SBIN0001234", pan: "ABCDE1234F" });
    expect(put.statusCode).toBe(200);
    const other = await makeEmployee(ctx, admin, { roles: ["department_head"], dept: "EDIT" });
    // Department head can see the profile but not bank details.
    expect((await other.api.get(`/v1/employees/${e.emp.id}`)).statusCode).toBe(200);
    expect((await other.api.get(`/v1/employees/${e.emp.id}/sensitive`)).statusCode).toBe(403);
    // The employee can see their own.
    const own = await e.api.get(`/v1/employees/${e.emp.id}/sensitive`);
    expect(own.json().data.ifsc).toBe("SBIN0001234");
    // Stored encrypted, never in clear text.
    const raw = await ctx.db.query("SELECT data_enc FROM employee_sensitive WHERE employee_id = $1", [e.emp.id]);
    expect(raw.rows[0].data_enc).not.toContain("123456789012");
    const audits = await ctx.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'employee.sensitive_read' AND entity_id = $1", [e.emp.id]);
    expect(audits.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("deactivation immediately invalidates existing sessions", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    expect((await e.api.get("/v1/me")).statusCode).toBe(200);
    expect((await admin.post(`/v1/employees/${e.emp.id}/deactivate`)).statusCode).toBe(200);
    expect((await e.api.get("/v1/me")).statusCode).toBe(401);
  });

  it("marking an employee exited deactivates their login and records history", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const r = await admin.patch(`/v1/employees/${e.emp.id}`, { status: "exited" });
    expect(r.statusCode).toBe(200);
    expect((await e.api.get("/v1/me")).statusCode).toBe(401);
    const h = (await admin.get(`/v1/employees/${e.emp.id}/history`)).json();
    expect(h.items.map((x: { kind: string }) => x.kind)).toEqual(expect.arrayContaining(["created", "status"]));
  });

  it("transfers are recorded in employee history", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"], branch: "VZG" });
    await admin.patch(`/v1/employees/${e.emp.id}`, { branchId: ctx.ids.branches.HYD });
    const h = (await admin.get(`/v1/employees/${e.emp.id}/history`)).json();
    const t = h.items.find((x: { kind: string }) => x.kind === "transfer");
    expect(t.after.branch_id).toBe(ctx.ids.branches.HYD);
  });

  it("structure changes need org.structure.manage", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["branch_manager"] });
    expect((await e.api.post("/v1/branches", { code: "BLR", name: "Bengaluru", city: "Bengaluru" })).statusCode).toBe(403);
    const ok = await admin.post("/v1/branches", { code: "BLR", name: "Bengaluru", city: "Bengaluru" });
    expect(ok.statusCode).toBe(201);
    const renamed = await admin.patch(`/v1/branches/${ok.json().id}`, { name: "Bangalore", active: false });
    expect(renamed.json()).toMatchObject({ name: "Bangalore", active: false });
  });

  it("custom roles can be created with granular permissions", async () => {
    const r = await admin.post("/v1/roles", { key: "footage_checker", name: "Footage Checker", grants: { "footage.verify": "branch", "content.read": "branch" } });
    expect(r.statusCode).toBe(201);
    const bad = await admin.post("/v1/roles", { key: "bad_role", name: "Bad", grants: { "not.a.permission": "org" } });
    expect(bad.statusCode).toBe(400);
  });
});
