import { z } from "zod";
import { CONTENT_STAGES } from "./content-workflow.js";
import { PREFIX_RE, SEGMENT_RE } from "./content-id.js";
import { PERMISSION_KEYS, SCOPES } from "./permissions.js";

/** Shared request/response validation. The API validates every body with these. */

export const uuid = z.string().uuid();
const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const LoginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const PasswordPolicy = z
  .string()
  .min(10, "At least 10 characters")
  .max(256)
  .refine((s) => /[a-z]/i.test(s) && /\d/.test(s), "Must contain letters and numbers");

export const ChangePasswordInput = z.object({ currentPassword: z.string().min(1), newPassword: PasswordPolicy });
export const RefreshInput = z.object({ refreshToken: z.string().min(20).max(512) });
export const ResetRequestInput = z.object({ email: z.string().trim().toLowerCase().email() });
export const ResetConfirmInput = z.object({ token: z.string().min(20).max(512), newPassword: PasswordPolicy });
export const MfaConfirmInput = z.object({ totp: z.string().regex(/^\d{6}$/) });

export const BranchInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}$/),
  name: trimmed(120),
  city: trimmed(120),
  timezone: z.string().default("Asia/Kolkata"),
  active: z.boolean().default(true),
});

export const DepartmentInput = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z_]{2,16}$/), name: trimmed(120), active: z.boolean().default(true) });
export const DesignationInput = z.object({ name: trimmed(120), departmentId: uuid.nullable().optional(), active: z.boolean().default(true) });

export const RoleInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  name: trimmed(80),
  description: z.string().max(500).default(""),
  mfaRequired: z.boolean().default(false),
  grants: z.record(z.enum(PERMISSION_KEYS as [string, ...string[]]), z.enum(SCOPES)),
});

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "intern", "consultant"] as const;
export const EMPLOYMENT_STATUSES = ["onboarding", "probation", "active", "notice", "exited", "archived"] as const;

export const CreateEmployeeInput = z.object({
  employeeCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/).optional(),
  fullName: trimmed(160),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^\+?[0-9 -]{7,20}$/).optional(),
  branchId: uuid,
  departmentId: uuid,
  designationId: uuid.optional(),
  reportingManagerId: uuid.optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default("full_time"),
  joiningDate: z.string().date(),
  roleKeys: z.array(z.string()).min(1).max(5).default(["employee"]),
  /** If omitted the API returns a one-time invitation token instead. */
  initialPassword: PasswordPolicy.optional(),
});
export type CreateEmployeeInput = z.infer<typeof CreateEmployeeInput>;

export const UpdateEmployeeInput = CreateEmployeeInput.omit({ email: true, initialPassword: true, roleKeys: true })
  .partial()
  .extend({ status: z.enum(EMPLOYMENT_STATUSES).optional() });

export const AssignRolesInput = z.object({ roleKeys: z.array(z.string()).min(1).max(5) });

export const SequenceInput = z.object({
  prefix: z.string().trim().toUpperCase().regex(PREFIX_RE),
  segmentMode: z.enum(["none", "year", "campaign"]).default("none"),
  padding: z.number().int().min(3).max(6).default(3),
});

export const CONTENT_FORMATS = ["reel", "short", "long_form", "story", "post", "podcast", "ad", "other"] as const;
export const PLATFORMS = ["instagram", "youtube", "facebook"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const CreateContentInput = z
  .object({
    title: trimmed(200),
    brief: z.string().max(10_000).default(""),
    clientId: uuid.optional(),
    channelId: uuid.optional(),
    branchId: uuid,
    departmentId: uuid.optional(),
    format: z.enum(CONTENT_FORMATS).default("reel"),
    platforms: z.array(z.enum(PLATFORMS)).max(3).default([]),
    language: z.string().max(40).default("Telugu"),
    priority: z.enum(PRIORITIES).default("normal"),
    dueAt: z.string().datetime({ offset: true }).optional(),
    requiresClientApproval: z.boolean().default(false),
    /** Optional campaign segment when the sequence uses segmentMode "campaign". */
    campaign: z.string().trim().toUpperCase().regex(SEGMENT_RE).optional(),
  })
  .refine((v) => Boolean(v.clientId) !== Boolean(v.channelId), {
    message: "Exactly one of clientId or channelId is required",
    path: ["clientId"],
  });
export type CreateContentInput = z.infer<typeof CreateContentInput>;

export const TransitionInput = z.object({
  to: z.enum(CONTENT_STAGES),
  note: z.string().trim().max(4000).optional(),
  /** New stage owner (user id). Must hold the right permission. */
  assigneeUserId: uuid.optional(),
  stageDueAt: z.string().datetime({ offset: true }).optional(),
  /** Optimistic concurrency: the version the client last saw. */
  expectedVersion: z.number().int().min(1),
});
export type TransitionInput = z.infer<typeof TransitionInput>;

export const CommentInput = z.object({ body: z.string().trim().min(1).max(4000) });

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
