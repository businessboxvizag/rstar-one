import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminApi, setupApp, teardown, type Api, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let admin: Api;
beforeAll(async () => {
  ctx = await setupApp();
  admin = await adminApi(ctx);
});
afterAll(async () => teardown(ctx));

const create = (api: Api, body: Record<string, unknown>) =>
  api.post("/v1/content", { title: "Test content", branchId: ctx.ids.branches.VZG, ...body });

describe("Content ID allocation", () => {
  it("issues sequential IDs per client and per channel, independently", async () => {
    const a = (await create(admin, { clientId: ctx.ids.clients.CarCart })).json();
    const b = (await create(admin, { clientId: ctx.ids.clients.CarCart })).json();
    const n = (await create(admin, { channelId: ctx.ids.channels["RSTAR News"] })).json();
    const ph = (await create(admin, { clientId: ctx.ids.clients["Pulse Hospital"] })).json();
    const av = (await create(admin, { clientId: ctx.ids.clients.Avakai })).json();
    expect(a.content_code).toBe("CC001");
    expect(b.content_code).toBe("CC002");
    expect(n.content_code).toBe("RN001");
    expect(ph.content_code).toBe("PH001");
    expect(av.content_code).toBe("AV001");
  });

  it("never duplicates or skips under 60 simultaneous requests", async () => {
    const channelId = ctx.ids.channels["RSTAR Health"];
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => create(admin, { channelId, title: `Concurrent ${i}` })));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const ids = results.map((r) => r.json().content_code as string);
    expect(new Set(ids).size).toBe(60);
    const nums = ids.map((x) => Number(x.slice(2))).sort((x, y) => x - y);
    expect(nums).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("finds content by ID, case-insensitively", async () => {
    const r = await admin.get("/v1/content/cc001");
    expect(r.statusCode).toBe(200);
    expect(r.json().content_code).toBe("CC001");
    const s = (await admin.get("/v1/content?q=cc00")).json();
    expect(s.items.map((x: { content_code: string }) => x.content_code)).toEqual(expect.arrayContaining(["CC001", "CC002"]));
  });

  it("never reuses the ID of a cancelled item, and items cannot be deleted", async () => {
    const c = (await create(admin, { clientId: ctx.ids.clients["Avakai.com"] })).json();
    expect(c.content_code).toBe("AVC001");
    const x = await admin.post(`/v1/content/${c.id}/transition`, { to: "cancelled", note: "Client dropped brief", expectedVersion: 1 });
    expect(x.statusCode).toBe(200);
    await expect(ctx.db.query("DELETE FROM content_items WHERE id = $1", [c.id])).rejects.toThrow(/cannot be deleted/);
    const next = (await create(admin, { clientId: ctx.ids.clients["Avakai.com"] })).json();
    expect(next.content_code).toBe("AVC002");
  });

  it("retires a prefix when it is changed, so it can never be issued again", async () => {
    const channels = (await admin.get("/v1/channels")).json().items as { name: string; sequence_id: string }[];
    const opinions = channels.find((c) => c.name === "RSTAR Opinions")!;
    expect((await create(admin, { channelId: ctx.ids.channels["RSTAR Opinions"] })).json().content_code).toBe("RO001");
    const upd = await admin.patch(`/v1/content-sequences/${opinions.sequence_id}`, { prefix: "ROP" });
    expect(upd.statusCode).toBe(200);
    expect((await create(admin, { channelId: ctx.ids.channels["RSTAR Opinions"] })).json().content_code).toBe("ROP002");
    // Old prefix is retired: nobody can claim RO again.
    const reuse = await admin.post("/v1/channels", { name: "Another channel", prefix: "RO" });
    expect(reuse.statusCode).toBe(400);
    // The old item keeps its original ID.
    expect((await admin.get("/v1/content/RO001")).statusCode).toBe(200);
  });

  it("supports a year segment", async () => {
    const ch = (await admin.post("/v1/channels", { name: "RSTAR Sports", prefix: "RS", segmentMode: "year" })).json();
    const c = (await create(admin, { channelId: ch.id })).json();
    expect(c.content_code).toBe(`RS-${new Date().getFullYear()}-001`);
  });

  it("supports campaign segments with separate numbering per campaign", async () => {
    const cl = (await admin.post("/v1/clients", { name: "Festival Client", prefix: "FC", segmentMode: "campaign" })).json();
    expect((await create(admin, { clientId: cl.id })).statusCode).toBe(400);
    expect((await create(admin, { clientId: cl.id, campaign: "DIWALI" })).json().content_code).toBe("FC-DIWALI-001");
    expect((await create(admin, { clientId: cl.id, campaign: "DIWALI" })).json().content_code).toBe("FC-DIWALI-002");
    expect((await create(admin, { clientId: cl.id, campaign: "SANKRANTI" })).json().content_code).toBe("FC-SANKRANTI-001");
  });

  it("rejects content without exactly one of client or channel", async () => {
    expect((await create(admin, {})).statusCode).toBe(400);
  });
});
