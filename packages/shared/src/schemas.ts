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
  channelId: z.string().nullable(),
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
  quickMode: z.boolean(),
  pendingSuggestion: z.string().nullable(),
  planEditToken: z.string().nullish(),
  pendingQuestions: z.string().nullable(),
  pendingQuestionIndex: z.number().nullable(),
  pendingAnswers: z.string().nullable(),
});

export const PollNextJobInput = z.object({
  workerId: z.string(),
  gitHead: z.string(),
});

export const PollNextJobOutput = z.object({
  jobs: z.array(JobSchema),
  gitMismatch: z.boolean(),
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
  quick: z.boolean().optional(),
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

const QuestionSchema = z.object({
  q: z.string(),
  options: z.array(z.string()).min(1),
  recommended: z.number().int().min(0),
});
export type Question = z.infer<typeof QuestionSchema>;

export const AskQuestionInput = z.object({
  jobId: z.number(),
  questions: z.array(QuestionSchema),
});

export const PollAnswerInput = z.object({
  jobId: z.number(),
});

export const GetBotHeadOutput = z.object({
  sha: z.string(),
});

export const PollAnswerOutput = z.object({
  answered: z.boolean(),
  formatted: z.string().nullable(),
});
