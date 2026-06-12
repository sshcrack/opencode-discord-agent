import { initTRPC } from "@trpc/server";
import {
  PollNextJobInput,
  GetJobStatusInput,
  PlanReadyInput,
  PostStatusInput,
  ApproveJobInput,
  CancelJobInput,
  SuggestChangesInput,
  AckSuggestionInput,
  JobSchema,
  StatusResult,
  GetSettingInput,
  GetSettingOutput,
  SetIssueNumberInput,
  RenameThreadInput,
  TypingInput,
  MarkCompleteInput,
  AskQuestionInput,
  PollAnswerInput,
  PollAnswerOutput,
  GetBotHeadOutput,
  PollNextJobOutput,
  ReleaseWorkerJobsInput,
  ReleaseWorkerJobsOutput,
  CreateReviewMergeJobInput,
} from "./schemas";

const t = initTRPC.create();

export const appRouter = t.router({
  pollNextJob: t.procedure
    .input(PollNextJobInput)
    .output(PollNextJobOutput)
    .query(async () => {
      throw new Error("Not implemented in shared package");
    }),

  getJobStatus: t.procedure
    .input(GetJobStatusInput)
    .output(JobSchema.nullable())
    .query(async () => {
      throw new Error("Not implemented in shared package");
    }),

  planReady: t.procedure
    .input(PlanReadyInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  postStatus: t.procedure
    .input(PostStatusInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  approveJob: t.procedure
    .input(ApproveJobInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  cancelJob: t.procedure
    .input(CancelJobInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  suggestChanges: t.procedure
    .input(SuggestChangesInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  ackSuggestion: t.procedure
    .input(AckSuggestionInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  getSetting: t.procedure
    .input(GetSettingInput)
    .output(GetSettingOutput)
    .query(async () => {
      throw new Error("Not implemented in shared package");
    }),

  setIssueNumber: t.procedure
    .input(SetIssueNumberInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  renameJobThread: t.procedure
    .input(RenameThreadInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  typing: t.procedure
    .input(TypingInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  markComplete: t.procedure
    .input(MarkCompleteInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  askQuestion: t.procedure
    .input(AskQuestionInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  pollAnswer: t.procedure
    .input(PollAnswerInput)
    .output(PollAnswerOutput)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  getBotHead: t.procedure
    .output(GetBotHeadOutput)
    .query(async () => {
      throw new Error("Not implemented in shared package");
    }),

  releaseWorkerJobs: t.procedure
    .input(ReleaseWorkerJobsInput)
    .output(ReleaseWorkerJobsOutput)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),

  createReviewMergeJob: t.procedure
    .input(CreateReviewMergeJobInput)
    .output(StatusResult)
    .mutation(async () => {
      throw new Error("Not implemented in shared package");
    }),
});

export type AppRouter = typeof appRouter;
