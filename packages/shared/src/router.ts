import { initTRPC } from "@trpc/server";
import {
  PollNextJobInput,
  PlanReadyInput,
  PostStatusInput,
  ApproveJobInput,
  CancelJobInput,
  SuggestChangesInput,
  JobSchema,
  StatusResult,
} from "./schemas";

const t = initTRPC.create();

export const appRouter = t.router({
  pollNextJob: t.procedure
    .input(PollNextJobInput)
    .output(JobSchema.nullable())
    .query(async ({ input }) => {
      throw new Error("Not implemented in shared package");
    }),

  planReady: t.procedure
    .input(PlanReadyInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      throw new Error("Not implemented in shared package");
    }),

  postStatus: t.procedure
    .input(PostStatusInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      throw new Error("Not implemented in shared package");
    }),

  approveJob: t.procedure
    .input(ApproveJobInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      throw new Error("Not implemented in shared package");
    }),

  cancelJob: t.procedure
    .input(CancelJobInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      throw new Error("Not implemented in shared package");
    }),

  suggestChanges: t.procedure
    .input(SuggestChangesInput)
    .output(StatusResult)
    .mutation(async ({ input }) => {
      throw new Error("Not implemented in shared package");
    }),
});

export type AppRouter = typeof appRouter;
