import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminApi, client, login, makeEmployee, setupApp, teardown, type Api, type TestCtx } from "./helpers.js";
import { hashPassword } from "../src/lib/crypto.js";

let ctx: TestCtx;
let admin: Api;
let clientId: string;
let otherClientId: string;
let people: Record<string, Awaited<ReturnType<typeof makeEmployee>>>;

beforeAll(async () => {
  ctx = await setupApp();
  admin = await adminApi(ctx);
  clientId = (await admin.post("/v1/clients", { name: "Workflow Client", prefix: "WF" })).json().id;
  otherClientId = (await admin.post("/v1/clients", { name: "Other Client", prefix: "OC" })).json().id;
  people = {
    producer: await makeEmployee(ctx, admin, { roles: ["project_manager"], dept: "MGMT" }),
    writer: await makeEmployee(ctx, admin, { roles: ["script_writer"], dept: "SCRIPT" }),
    camera: await makeEmployee(ctx, admin, { roles: ["camera_operator"], dept: "CAMERA", branch: "HYD" }),
    editor: await makeEmployee(ctx, admin, { roles: ["video_editor"], dept: "EDIT" }),
    otherEditor: await makeEmployee(ctx, admin, { roles: ["video_editor"], dept: "EDIT" }),
    social: await makeEmployee(ctx, admin, { roles: ["social_media_manager"], dept: "SOCIAL" }),
    management: await makeEmployee(ctx, admin, { roles: ["employee"], dept: "MGMT" }),
  };
});
afterAll(async () => teardown(ctx));

async function step(api: Api, id: string, to: string, extra: Record<string, unknown> = {}) {
  const cur = (await admin.get(`/v1/content/${id}`)).json();
  const r = await api.post(`/v1/content/${id}/transition`, { to, expectedVersion: cur.version, ...extra });
  if (r.statusCode !== 200) throw new Error(`${to}: ${r.statusCode} ${r.body}`);
  return r.json();
}

describe("media production lifecycle", () => {
  it("moves one Content ID through every stage with owners, history and notifications", async () => {
    const { producer, writer, camera, editor, social } = people as Required<typeof people>;
    const c = (await producer!.api.post("/v1/content", { title: "CarCart showroom reel", clientId, branchId: ctx.ids.branches.VZG, requiresClientApproval: true })).json();
    expect(c.content_code).toBe("WF001");
    expect(c.stage).toBe("idea");

    await step(producer!.api, c.id, "script_assigned", { assigneeUserId: writer!.userId });
    // The writer can now see it (own scope via assignment) and is notified.
    expect((await writer!.api.get(`/v1/content/${c.id}`)).statusCode).toBe(200);
    const notes = (await writer!.api.get("/v1/notifications")).json();
    expect(notes.items[0].title).toBe("WF001: Script writing assigned");

    await step(writer!.api, c.id, "script_submitted");
    await step(producer!.api, c.id, "script_in_review");
    // Rejection requires a reason and sends the script back to the writer.
    const noReason = await producer!.api.post(`/v1/content/${c.id}/transition`, { to: "script_assigned", expectedVersion: 4 });
    expect(noReason.statusCode).toBe(400);
    await step(producer!.api, c.id, "script_assigned", { note: "Tighten the opening" });
    await step(writer!.api, c.id, "script_submitted");
    await step(producer!.api, c.id, "script_in_review");
    await step(producer!.api, c.id, "script_approved");
    await step(producer!.api, c.id, "shoot_scheduled");
    await step(producer!.api, c.id, "shoot_assigned", { assigneeUserId: camera!.userId });
    await step(camera!.api, c.id, "shoot_in_progress");
    await step(camera!.api, c.id, "shoot_completed");
    await step(camera!.api, c.id, "footage_upload_initiated");
    await step(camera!.api, c.id, "footage_received");
    await step(producer!.api, c.id, "footage_verification");
    await step(producer!.api, c.id, "footage_accepted");
    await step(producer!.api, c.id, "editor_assigned", { assigneeUserId: editor!.userId });
    await step(editor!.api, c.id, "editing_in_progress");
    await step(editor!.api, c.id, "first_cut_submitted");
    await step(producer!.api, c.id, "internal_review");
    await step(producer!.api, c.id, "revisions_requested", { note: "Logo too small at 0:12" });
    await step(editor!.api, c.id, "editing_in_progress");
    await step(editor!.api, c.id, "first_cut_submitted");
    await step(producer!.api, c.id, "internal_review");
    await step(producer!.api, c.id, "client_review");
    await step(producer!.api, c.id, "first_cut_approved"); // management approval path
    await step(editor!.api, c.id, "final_cut_submitted");
    await step(producer!.api, c.id, "final_approved", { assigneeUserId: social!.userId });
    await step(social!.api, c.id, "posting_scheduled");
    await step(social!.api, c.id, "published");
    await step(social!.api, c.id, "analytics_24h");
    await step(social!.api, c.id, "analytics_7d");
    await step(social!.api, c.id, "analytics_30d");
    const done = await step(producer!.api, c.id, "archived");
    expect(done.stage).toBe("archived");
    expect(done.revision_count).toBe(1);

    const history = (await producer!.api.get(`/v1/content/${c.id}/history`)).json().items;
    expect(history[0].kind).toBe("created");
    expect(history.filter((h: { kind: string }) => h.kind === "transition")).toHaveLength(33);
    expect(history.find((h: { to_stage: string }) => h.to_stage === "revisions_requested").note).toBe("Logo too small at 0:12");

    const audits = await ctx.db.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id = 'WF001' AND action = 'content.transition'");
    expect(audits.rows[0].n).toBe(33);
  });

  it("blocks people from actions outside their role or assignment", async () => {
    const { producer, writer, editor, otherEditor } = people as Required<typeof people>;
    const c = (await producer!.api.post("/v1/content", { title: "Permissions check", clientId, branchId: ctx.ids.branches.VZG })).json();
    // A script writer cannot assign work.
    expect((await writer!.api.post(`/v1/content/${c.id}/transition`, { to: "script_assigned", expectedVersion: 1, assigneeUserId: writer!.userId })).statusCode).toBe(404);
    // Cannot skip stages.
    expect((await producer!.api.post(`/v1/content/${c.id}/transition`, { to: "published", expectedVersion: 1 })).statusCode).toBe(400);
    // Assignee must hold the matching permission (a writer cannot be made the editor).
    await step(producer!.api, c.id, "footage_upload_initiated", { assigneeUserId: people.camera!.userId });
    await step(people.camera!.api, c.id, "footage_received");
    await step(producer!.api, c.id, "footage_verification");
    await step(producer!.api, c.id, "footage_accepted");
    const wrong = await producer!.api.post(`/v1/content/${c.id}/transition`, { to: "editor_assigned", expectedVersion: 5, assigneeUserId: writer!.userId });
    expect(wrong.statusCode).toBe(400);
    await step(producer!.api, c.id, "editor_assigned", { assigneeUserId: editor!.userId });
    // Another editor cannot work on someone else's assignment (and cannot even see it).
    expect((await otherEditor!.api.post(`/v1/content/${c.id}/transition`, { to: "editing_in_progress", expectedVersion: 6 })).statusCode).toBe(404);
    // The assigned editor cannot approve their own cut.
    await step(editor!.api, c.id, "editing_in_progress");
    await step(editor!.api, c.id, "first_cut_submitted");
    expect((await editor!.api.post(`/v1/content/${c.id}/transition`, { to: "internal_review", expectedVersion: 8 })).statusCode).toBe(403);
  });

  it("rejects stale updates with 409 (two people acting at once)", async () => {
    const { producer, writer } = people;
    const c = (await producer!.api.post("/v1/content", { title: "Race", clientId, branchId: ctx.ids.branches.VZG })).json();
    const [a, b] = await Promise.all([
      producer!.api.post(`/v1/content/${c.id}/transition`, { to: "script_assigned", expectedVersion: 1, assigneeUserId: writer!.userId }),
      producer!.api.post(`/v1/content/${c.id}/transition`, { to: "cancelled", expectedVersion: 1, note: "dup" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it("lets a client portal user approve only their own content and see only client-safe fields", async () => {
    const { producer, editor } = people;
    // Client users are provisioned by staff in the CRM milestone; created directly here.
    const u = (
      await ctx.db.query(
        `INSERT INTO users (organisation_id, kind, email, display_name, password_hash, client_id) VALUES ($1,'client','client@wf.test','WF Client',$2,$3) RETURNING id`,
        [ctx.orgId, await hashPassword("ClientPass123"), clientId],
      )
    ).rows[0];
    await ctx.db.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE organisation_id = $2 AND key = 'client_user'", [u.id, ctx.orgId]);
    const portal = client(ctx.app, (await login(ctx.app, "client@wf.test", "ClientPass123")).accessToken);

    const c = (await producer!.api.post("/v1/content", { title: "Needs client OK", clientId, branchId: ctx.ids.branches.VZG, requiresClientApproval: true })).json();
    const other = (await producer!.api.post("/v1/content", { title: "Other client", clientId: otherClientId, branchId: ctx.ids.branches.VZG })).json();
    expect((await portal.get(`/v1/content/${other.id}`)).statusCode).toBe(404);
    expect((await portal.get("/v1/employees")).statusCode).toBe(403);

    await step(producer!.api, c.id, "footage_upload_initiated", { assigneeUserId: people.camera!.userId });
    await step(people.camera!.api, c.id, "footage_received");
    await step(producer!.api, c.id, "footage_verification");
    await step(producer!.api, c.id, "footage_accepted");
    await step(producer!.api, c.id, "editor_assigned", { assigneeUserId: editor!.userId });
    await step(editor!.api, c.id, "editing_in_progress");
    await step(editor!.api, c.id, "first_cut_submitted");
    await step(producer!.api, c.id, "internal_review");
    await step(producer!.api, c.id, "client_review");

    const seen = (await portal.get(`/v1/content/${c.id}`)).json();
    expect(seen.stage).toBe("client_review");
    expect(seen.brief).toBeUndefined();
    expect(seen.stage_owner_id).toBeUndefined();
    expect(seen.actions.map((a: { to: string }) => a.to)).toEqual(["first_cut_approved", "revisions_requested"]);
    const list = (await portal.get("/v1/content")).json().items.map((x: { id: string }) => x.id);
    expect(list).toContain(c.id);
    expect(list).not.toContain(other.id);

    const approved = await portal.post(`/v1/content/${c.id}/transition`, { to: "first_cut_approved", expectedVersion: seen.version });
    expect(approved.statusCode).toBe(200);
    // Portal users never see internal comments.
    await producer!.api.post(`/v1/content/${c.id}/comments`, { body: "internal only" });
    await producer!.api.post(`/v1/content/${c.id}/comments`, { body: "thanks!", visibility: "client" });
    const comments = (await portal.get(`/v1/content/${c.id}/comments`)).json().items.map((x: { body: string }) => x.body);
    expect(comments).toEqual(["thanks!"]);
  });
});
