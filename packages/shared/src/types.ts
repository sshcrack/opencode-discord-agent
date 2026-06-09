import { z } from "zod";

export const ThreadStatus = {
  COLLECTING: "COLLECTING",
  SUBMITTED: "SUBMITTED",
  PLANNING: "PLANNING",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  BUILDING: "BUILDING",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
} as const;

export type ThreadStatus = (typeof ThreadStatus)[keyof typeof ThreadStatus];

export const JobStatus = {
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  PLANNING: "PLANNING",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  BUILDING: "BUILDING",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const JobKind = {
  BUG: "BUG",
  FEATURE: "FEATURE",
  OTHER: "OTHER",
} as const;

export type JobKind = (typeof JobKind)[keyof typeof JobKind];

export const JobPayloadSchema = z.object({
  repo: z.string(),
  kind: z.enum(["BUG", "FEATURE", "OTHER"]),
  context: z.string(),
  fileUrls: z.array(z.string()).default([]),
  autoMode: z.boolean().default(false),
  pendingSuggestion: z.string().optional(),
});

export type JobPayload = z.infer<typeof JobPayloadSchema>;

export const StatusUpdateSchema = z.object({
  jobId: z.string(),
  message: z.string(),
  level: z.enum(["info", "success", "error"]).default("info"),
  prUrl: z.string().optional(),
  issueUrl: z.string().optional(),
});

export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;

export const PlanReadySchema = z.object({
  jobId: z.string(),
  planMarkdown: z.string(),
  sessionId: z.string(),
});

export type PlanReady = z.infer<typeof PlanReadySchema>;

export const SuggestionSchema = z.object({
  jobId: z.string(),
  text: z.string(),
  sessionId: z.string(),
});

export type Suggestion = z.infer<typeof SuggestionSchema>;

export const ApprovalSchema = z.object({
  jobId: z.string(),
  approved: z.boolean(),
});

export type Approval = z.infer<typeof ApprovalSchema>;

export const HeartbeatSchema = z.object({
  workerId: z.string(),
});

export type Heartbeat = z.infer<typeof HeartbeatSchema>;

export const ClaimResponseSchema = z.object({
  job: z
    .object({
      id: z.string(),
      payload: JobPayloadSchema,
      worktreeBranch: z.string().nullable(),
      status: z.string(),
      repoPath: z.string(),
    })
    .nullable(),
});

export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;
