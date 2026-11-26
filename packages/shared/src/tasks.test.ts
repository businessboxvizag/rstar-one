import { describe, expect, it } from "vitest";
import { TaskCreateInput, TaskStatusInput, TaskUpdateInput, canSetTaskStatus } from "./tasks.js";

describe("task status rules", () => {
  it("lets the assignee start, block, finish and reopen", () => {
    expect(canSetTaskStatus("open", "in_progress", "assignee")).toBe(true);
    expect(canSetTaskStatus("in_progress", "blocked", "assignee")).toBe(true);
    expect(canSetTaskStatus("blocked", "done", "assignee")).toBe(true);
    expect(canSetTaskStatus("done", "in_progress", "assignee")).toBe(true);
  });
  it("keeps cancelling and restoring with the manager", () => {
    expect(canSetTaskStatus("open", "cancelled", "assignee")).toBe(false);
    expect(canSetTaskStatus("cancelled", "in_progress", "assignee")).toBe(false);
    expect(canSetTaskStatus("in_progress", "open", "assignee")).toBe(false);
    expect(canSetTaskStatus("open", "cancelled", "manager")).toBe(true);
    expect(canSetTaskStatus("cancelled", "open", "manager")).toBe(true);
  });
  it("only reopens a finished task", () => {
    expect(canSetTaskStatus("done", "blocked", "assignee")).toBe(false);
    expect(canSetTaskStatus("done", "open", "manager")).toBe(false);
    expect(canSetTaskStatus("done", "cancelled", "manager")).toBe(true);
  });
  it("rejects no-op changes", () => expect(canSetTaskStatus("done", "done", "manager")).toBe(false));
});

describe("task inputs", () => {
  it("requires a note to block or cancel", () => {
    expect(TaskStatusInput.safeParse({ status: "blocked", expectedVersion: 1 }).success).toBe(false);
    expect(TaskStatusInput.safeParse({ status: "blocked", note: "Waiting on client", expectedVersion: 1 }).success).toBe(true);
    expect(TaskStatusInput.safeParse({ status: "done", expectedVersion: 1 }).success).toBe(true);
  });
  it("defaults priority and validates dates", () => {
    const r = TaskCreateInput.parse({ title: "Edit promo" });
    expect(r.priority).toBe("normal");
    expect(TaskCreateInput.safeParse({ title: "Edit promo", dueDate: "26/11/2026" }).success).toBe(false);
  });
  it("rejects an update with nothing to change", () => {
    expect(TaskUpdateInput.safeParse({ expectedVersion: 2 }).success).toBe(false);
    expect(TaskUpdateInput.safeParse({ dueDate: null, expectedVersion: 2 }).success).toBe(true);
  });
});
