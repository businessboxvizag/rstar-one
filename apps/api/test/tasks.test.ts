import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, dateInZone } from "@rstar/shared";
import { adminApi, makeEmployee, setupApp, teardown, type Api, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let admin: Api;
const today = () => dateInZone(new Date(), "Asia/Kolkata");

beforeAll(async () => {
  ctx = await setupApp();
  admin = await adminApi(ctx);
});
afterAll(async () => teardown(ctx));

const notes = async (api: Api) => (await api.get("/v1/notifications")).json().items as { kind: string; title: string; entity_id: string }[];

describe("tasks", () => {
  it("manager assigns to a direct report; report works it; manager is told; history is kept", async () => {
    const mgr = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const rep = await makeEmployee(ctx, admin, { roles: ["employee"], managerId: mgr.emp.id });

    const people = (await mgr.api.get("/v1/tasks/assignees")).json().items.map((x: { employeeId: string }) => x.employeeId);
    expect(people).toEqual(expect.arrayContaining([mgr.emp.id, rep.emp.id]));

    const c = await mgr.api.post("/v1/tasks", { title: "Cut the Diwali promo", assigneeEmployeeId: rep.emp.id, priority: "high", dueDate: addDays(today(), 2) });
    expect(c.statusCode).toBe(201);
    const t = c.json();
    expect(t).toMatchObject({ status: "open", priority: "high", assignee: { employeeId: rep.emp.id }, createdBy: { isMe: true } });
    expect((await notes(rep.api)).some((n) => n.kind === "task.assigned" && n.entity_id === t.id)).toBe(true);

    expect((await rep.api.get("/v1/tasks?view=mine")).json().items.map((x: { id: string }) => x.id)).toContain(t.id);
    expect((await mgr.api.get("/v1/tasks?view=created")).json().items.map((x: { id: string }) => x.id)).toContain(t.id);
    expect((await mgr.api.get("/v1/tasks?view=team")).json().items.map((x: { id: string }) => x.id)).toContain(t.id);

    // The assignee cannot cancel or edit; they can start, block (with note) and finish.
    expect((await rep.api.post(`/v1/tasks/${t.id}/status`, { status: "cancelled", note: "nope", expectedVersion: 1 })).statusCode).toBe(403);
    expect((await rep.api.patch(`/v1/tasks/${t.id}`, { title: "Mine now", expectedVersion: 1 })).statusCode).toBe(403);
    expect((await rep.api.post(`/v1/tasks/${t.id}/status`, { status: "blocked", expectedVersion: 1 })).statusCode).toBe(400);
    const s1 = await rep.api.post(`/v1/tasks/${t.id}/status`, { status: "in_progress", expectedVersion: 1 });
    expect(s1.json()).toMatchObject({ status: "in_progress", version: 2 });
    expect((await rep.api.post(`/v1/tasks/${t.id}/status`, { status: "done", expectedVersion: 1 })).statusCode).toBe(409);
    const s2 = await rep.api.post(`/v1/tasks/${t.id}/status`, { status: "done", expectedVersion: 2 });
    expect(s2.json().status).toBe("done");
    expect(s2.json().completedAt).toBeTruthy();
    expect((await notes(mgr.api)).some((n) => n.kind === "task.status" && n.entity_id === t.id)).toBe(true);

    expect((await rep.api.post(`/v1/tasks/${t.id}/comments`, { body: "Uploaded to the drive" })).statusCode).toBe(201);
    const d = (await mgr.api.get(`/v1/tasks/${t.id}`)).json();
    expect(d.comments.map((x: { body: string }) => x.body)).toEqual(["Uploaded to the drive"]);
    expect(d.history.map((h: { kind: string; to: string }) => `${h.kind}:${h.to}`)).toEqual([`created:${rep.emp.full_name}`, "status:in_progress", "status:done"]);
    expect(d.can).toMatchObject({ manage: true });
    expect((await notes(mgr.api)).some((n) => n.kind === "task.comment")).toBe(true);
  });

  it("cannot assign to people you don't manage, and their tasks stay hidden", async () => {
    const a = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const b = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const r = await a.api.post("/v1/tasks", { title: "Do my work", assigneeEmployeeId: b.emp.id });
    expect(r.statusCode).toBe(403);
    expect((await a.api.get("/v1/tasks/assignees")).json().items.map((x: { employeeId: string }) => x.employeeId)).not.toContain(b.emp.id);

    const own = await b.api.post("/v1/tasks", { title: "Personal to-do" });
    expect(own.statusCode).toBe(201);
    expect(own.json().assignee.isMe).toBe(true);
    expect((await a.api.get(`/v1/tasks/${own.json().id}`)).statusCode).toBe(404);
    expect((await a.api.post(`/v1/tasks/${own.json().id}/comments`, { body: "hi" })).statusCode).toBe(404);
    // Admin (org scope) sees and can manage it.
    expect((await admin.get(`/v1/tasks/${own.json().id}`)).json().can.manage).toBe(true);
  });

  it("reassigning notifies both people; overdue is flagged; cancel needs a note", async () => {
    const mgr = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const r1 = await makeEmployee(ctx, admin, { roles: ["employee"], managerId: mgr.emp.id });
    const r2 = await makeEmployee(ctx, admin, { roles: ["employee"], managerId: mgr.emp.id });
    const t = (await mgr.api.post("/v1/tasks", { title: "Collect shoot permits", assigneeEmployeeId: r1.emp.id, dueDate: addDays(today(), -1) })).json();
    expect(t.overdue).toBe(true);
    expect((await r1.api.get("/v1/tasks/summary")).json()).toMatchObject({ open: 1, overdue: 1 });
    expect((await mgr.api.get("/v1/tasks?view=team&overdue=true")).json().items.map((x: { id: string }) => x.id)).toContain(t.id);

    const re = await mgr.api.patch(`/v1/tasks/${t.id}`, { assigneeEmployeeId: r2.emp.id, dueDate: addDays(today(), 3), expectedVersion: 1 });
    expect(re.statusCode).toBe(200);
    expect(re.json()).toMatchObject({ assignee: { employeeId: r2.emp.id }, overdue: false, version: 2 });
    expect((await notes(r2.api)).some((n) => n.kind === "task.assigned" && n.entity_id === t.id)).toBe(true);
    expect((await notes(r1.api)).some((n) => n.kind === "task.reassigned" && n.entity_id === t.id)).toBe(true);
    expect((await r1.api.get(`/v1/tasks/${t.id}`)).statusCode).toBe(404);

    expect((await mgr.api.post(`/v1/tasks/${t.id}/status`, { status: "cancelled", expectedVersion: 2 })).statusCode).toBe(400);
    const cx = await mgr.api.post(`/v1/tasks/${t.id}/status`, { status: "cancelled", note: "Permits not needed", expectedVersion: 2 });
    expect(cx.json().status).toBe("cancelled");
    expect((await r2.api.post(`/v1/tasks/${t.id}/status`, { status: "in_progress", expectedVersion: 3 })).statusCode).toBe(403);
    expect((await mgr.api.get("/v1/tasks?view=team&status=cancelled")).json().items.map((x: { id: string }) => x.id)).toContain(t.id);
  });

  it("links a task to a Content ID and finds it by number", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    expect((await e.api.post("/v1/tasks", { title: "Thumbnail", contentCode: "ZZ999" })).statusCode).toBe(400);
    const t = (await e.api.post("/v1/tasks", { title: "Find me by number" })).json();
    expect((await e.api.get(`/v1/tasks?q=T-${t.number}`)).json().items.map((x: { id: string }) => x.id)).toEqual([t.id]);
  });
});

describe("empty JSON bodies", () => {
  it("accepts an action POST with content-type json and no body (browser 2FA set-up)", async () => {
    const e = await makeEmployee(ctx, admin, { roles: ["employee"] });
    const tok = (await ctx.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: e.email, password: e.password } })).json().accessToken;
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/mfa/setup", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().otpauthUrl).toMatch(/^otpauth:/);
    const bad = await ctx.app.inject({ method: "POST", url: "/v1/tasks", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, payload: "{nope" });
    expect(bad.statusCode).toBe(400);
  });
});
