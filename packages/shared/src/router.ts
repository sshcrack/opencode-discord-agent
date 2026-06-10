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
} from "./schemas";

const t = initTRPC.create();

export const appRouter = t.router({
  pollNextJob: t.procedure
    .input(PollNextJobInput)
    .output(JobSchema.nullable())
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
});

export type AppRouter = typeof appRouter;
