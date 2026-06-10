import { z } from "zod";

export const ReportKind = z.enum(["bug", "feature", "refactor", "other"]);
export type ReportKind = z.infer<typeof ReportKind>;

export const JobStatus = z.enum([
  "pending",
  "claimed",
  "planning",
  "plan_ready",
  "approved",
  "cancelled",
  "building",
  "done",
  "failed",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const StatusLevel = z.enum(["debug", "info", "success", "error"]);
export type StatusLevel = z.infer<typeof StatusLevel>;

export const AutoMode = z.enum(["on", "off"]);
export type AutoMode = z.infer<typeof AutoMode>;

export const RepositorySchema = z.object({
  id: z.number(),
  slug: z.string(),
  path: z.string(),
  isDefault: z.boolean(),
});

export const ReportThreadSchema = z.object({
  id: z.number(),
  threadId: z.string(),
  kind: ReportKind,
  repoSlug: z.string(),
});

export const JobSchema = z.object({
  id: z.number(),
  threadId: z.string(),
  repoSlug: z.string(),
  repoPath: z.string(),
  kind: ReportKind,
  status: JobStatus,
  context: z.string().nullable(),
  workerId: z.string().nullable(),
  reporterId: z.string().nullable(),
  planMd: z.string().nullable(),
  opencodeSessionId: z.string().nullable(),
  issueNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
  autoMode: z.boolean(),
  pendingSuggestion: z.string().nullable(),
  planEditToken: z.string().nullish(),
});

export const PollNextJobInput = z.object({
  workerId: z.string(),
});

export const GetJobStatusInput = z.object({
  jobId: z.number(),
  workerId: z.string(),
});

export const PlanReadyInput = z.object({
  jobId: z.number(),
  planMd: z.string(),
  sessionId: z.string(),
});

export const PostStatusInput = z.object({
  jobId: z.number(),
  message: z.string(),
  level: StatusLevel,
  append: z.boolean().optional().default(false),
});

export const ApproveJobInput = z.object({
  jobId: z.number(),
});

export const CancelJobInput = z.object({
  jobId: z.number(),
});

export const SuggestChangesInput = z.object({
  jobId: z.number(),
  suggestion: z.string(),
});

export const AckSuggestionInput = z.object({
  jobId: z.number(),
});

export const CreateReportInput = z.object({
  kind: ReportKind,
  repoSlug: z.string(),
});

export const AddRepoInput = z.object({
  slug: z.string(),
  path: z.string(),
});

export const SetDefaultRepoInput = z.object({
  slug: z.string(),
});

export const SubmitJobInput = z.object({
  threadId: z.string(),
  auto: z.boolean().optional(),
});

export const StatusResult = z.object({
  success: z.boolean(),
});

export const PlanReadyOutput = z.object({
  success: z.boolean(),
  autoApproved: z.boolean().optional(),
});

export const GetSettingInput = z.object({
  key: z.string(),
});

export const SetIssueNumberInput = z.object({
  jobId: z.number(),
  issueNumber: z.number(),
});

export const GetSettingOutput = z.object({
  value: z.string().nullable(),
});

export const TypingInput = z.object({
  jobId: z.number(),
  threadId: z.string(),
});

export const RenameThreadInput = z.object({
  jobId: z.number(),
  name: z.string().max(100),
});

export const MarkCompleteInput = z.object({
  jobId: z.number(),
  prUrl: z.string(),
});
